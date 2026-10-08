/**
 * OAuth children end to end: an in-process hub served over HTTP, a local fake
 * authorization server + protected MCP server, and the test playing the browser.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Hub } from "./hub.js";
import { startHttp } from "./http.js";
import { FakeOAuthServer } from "./oauth-fake.js";
import { STORE_FILE } from "./oauth/store.js";
import { createRunner } from "./test-runner.js";
import type { Config } from "./types.js";

type TextContent = { type: string; text: string };
const TOKEN = "oauth-e2e-token";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

/** Raw request, for headers fetch will not let us set (Host). */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => res({ status: r.statusCode!, headers: r.headers, body }));
    });
    req.once("error", rej);
    req.end();
  });
}

async function run() {
  const { test, finish } = createRunner();
  console.log("OAuth e2e tests\n");

  const fake = new FakeOAuthServer();
  await fake.start();
  const storeDir = await mkdtemp(join(tmpdir(), "mcp-hub-oauth-"));
  const port = await freePort();
  const hubOrigin = `http://127.0.0.1:${port}`;
  const config: Config = {
    servers: {
      fake: { transport: "streamable-http", url: `${fake.origin}/mcp`, always: ["echo"], oauth: { allowPrivateNetwork: true } },
      // Collides with fake's list_cities: whoever is installed first keeps the name.
      weather: { command: "node", args: ["examples/weather/dist/index.js"], prefix: "fake__" },
      // Same private endpoint without allowPrivateNetwork: the network guard must refuse it.
      guarded: { transport: "streamable-http", url: `${fake.origin}/mcp`, oauth: true },
    },
    clients: { test: { tokenEnv: "UNUSED" } },
    oauth: { redirectUrl: `${hubOrigin}/oauth/callback`, storeDir },
  };

  let hub = new Hub();
  await hub.start(config);
  let http: HttpServer = await startHttp(hub, { host: "127.0.0.1", port }, new Map([["test", TOKEN]]));

  const mcp = async () => {
    const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${hubOrigin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
    return client;
  };
  const client = await mcp();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: "call_tool", arguments: { name, arguments: args } });
    return { isError: r.isError === true, text: (r.content as TextContent[])[0].text };
  };
  const listed = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const status = (name: string) => hub.servers().find((s) => s.name === name)!.status;
  const stored = async () => JSON.parse(await readFile(join(storeDir, STORE_FILE), "utf8")).credentials.fake;
  const start = (name = "fake", origin: string | null = hubOrigin) =>
    fetch(`${hubOrigin}/oauth/start/${name}`, { method: "POST", redirect: "manual", headers: origin ? { Origin: origin } : {} });
  /** Play the browser at the provider: follow the authorization URL to the callback URL. */
  const consent = async (authorizationUrl: string) => {
    const r = await fetch(authorizationUrl, { redirect: "manual" });
    assert.strictEqual(r.status, 302, "the fake refused the authorization request");
    return r.headers.get("location")!;
  };
  const authorize = async () => {
    const s = await start();
    assert.strictEqual(s.status, 303);
    return fetch(await consent(s.headers.get("location")!));
  };

  try {
    await test("startup without a token: needs-auth, hub serves the other children", async () => {
      assert.strictEqual(status("fake"), "needs-auth");
      assert.strictEqual(status("weather"), "connected");
      assert.deepStrictEqual(await listed(), ["call_tool", "list_tools"]);
      const cities = await call("fake__list_cities");
      assert.ok(!cities.isError && cities.text.includes("paris"), "weather keeps its tools");
    });

    await test("private endpoint without allowPrivateNetwork fails, never asks for consent", async () => {
      assert.strictEqual(status("guarded"), "failed");
      const s = await start("guarded");
      assert.strictEqual(s.status, 502);
    });

    await test("status page: every child, its state, a connect form, safe headers", async () => {
      const r = await fetch(`${hubOrigin}/`);
      const html = await r.text();
      assert.strictEqual(r.status, 200);
      for (const text of ["fake", "needs-auth", "weather", "connected", "guarded", "failed", 'action="/oauth/start/fake"']) {
        assert.ok(html.includes(text), text);
      }
      assert.ok(!html.includes('action="/oauth/start/weather"'));
      assert.strictEqual(r.headers.get("cache-control"), "no-store");
      assert.strictEqual(r.headers.get("referrer-policy"), "no-referrer");
      assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
      assert.ok(r.headers.get("content-security-policy")!.includes("frame-ancestors 'none'"));
    });

    await test("start -> provider -> callback: PKCE, exact redirect, tools appear", async () => {
      const callback = await authorize();
      assert.strictEqual(callback.status, 200, await callback.clone().text());
      assert.ok((await callback.text()).includes("Connected"));
      const q = fake.authorizeRequests.at(-1)!;
      assert.strictEqual(q.get("redirect_uri"), `${hubOrigin}/oauth/callback`);
      assert.strictEqual(q.get("code_challenge_method"), "S256");
      assert.strictEqual(fake.counts.register, 1);
      assert.strictEqual(status("fake"), "connected");
      assert.deepStrictEqual(await listed(), ["call_tool", "fake__echo", "list_tools"]);
      const echo = await call("fake__echo", { x: 1 });
      assert.ok(!echo.isError);
      assert.deepStrictEqual(JSON.parse(echo.text), { tool: "echo", args: { x: 1 } });
    });

    await test("collisions survive the reconnect: fake__list_cities stays weather's", async () => {
      const cities = await call("fake__list_cities");
      assert.ok(cities.text.includes("paris"), cities.text);
      const r = await client.callTool({ name: "fake__echo", arguments: { direct: true } });
      assert.ok(!r.isError, "always tool callable directly");
    });

    await test("store: 0600 file in a 0700 directory, no PKCE verifier, page shows no secret", async () => {
      const { lstat } = await import("node:fs/promises");
      assert.strictEqual((await lstat(storeDir)).mode & 0o777, 0o700);
      assert.strictEqual((await lstat(join(storeDir, STORE_FILE))).mode & 0o777, 0o600);
      const record = await stored();
      assert.ok(record.tokens.refresh_token);
      assert.deepStrictEqual(Object.keys(record).sort(), ["clientInformation", "discoveryState", "endpoint", "tokens"]);
      const html = await (await fetch(`${hubOrigin}/`)).text();
      assert.ok(!html.includes(record.tokens.access_token) && !html.includes(record.tokens.refresh_token));
    });

    await test("expired access token: transparent refresh, rotated refresh token persisted", async () => {
      const before = (await stored()).tokens.refresh_token;
      const refreshes = fake.counts.refreshGrant;
      fake.expireAccessTokens();
      const echo = await call("fake__echo");
      assert.ok(!echo.isError, echo.text);
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
      assert.notStrictEqual((await stored()).tokens.refresh_token, before);
    });

    await test("refresh response without a refresh token keeps the previous one", async () => {
      fake.behaviour.omitRefreshToken = true;
      const before = (await stored()).tokens.refresh_token;
      fake.expireAccessTokens();
      assert.ok(!(await call("fake__echo")).isError);
      assert.strictEqual((await stored()).tokens.refresh_token, before);
      fake.behaviour.omitRefreshToken = false;
      fake.expireAccessTokens();
      assert.ok(!(await call("fake__echo")).isError, "the kept refresh token still works");
    });

    await test("concurrent calls on an expired token: one refresh, all succeed", async () => {
      fake.behaviour.tokenDelayMs = 150;
      const refreshes = fake.counts.refreshGrant;
      fake.expireAccessTokens();
      const results = await Promise.all([1, 2, 3, 4].map((i) => call("fake__echo", { i })));
      fake.behaviour.tokenDelayMs = 0;
      assert.ok(results.every((r) => !r.isError), JSON.stringify(results));
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
      assert.strictEqual(status("fake"), "connected");
    });

    await test("token endpoint outage (503, then dropped connection): failure, not needs-auth", async () => {
      for (const failure of ["server_error", "down"] as const) {
        fake.behaviour.refreshFailure = failure;
        fake.expireAccessTokens();
        const r = await call("fake__echo");
        assert.ok(r.isError, failure);
        assert.ok(!r.text.includes("needs authorization"), r.text);
        assert.strictEqual(status("fake"), "connected", failure);
        assert.ok((await stored()).tokens.refresh_token, "the refresh token is kept");
      }
      fake.behaviour.refreshFailure = undefined;
      assert.ok(!(await call("fake__echo")).isError, "recovers once the server is back");
    });

    await test("invalid_grant: tokens dropped, needs-auth with a readable isError, hidden from lists", async () => {
      fake.behaviour.refreshFailure = "invalid_grant";
      fake.expireAccessTokens();
      const r = await call("fake__echo");
      assert.ok(r.isError);
      assert.strictEqual(r.text, `Server "fake" needs authorization: open ${hubOrigin}/`);
      assert.strictEqual(status("fake"), "needs-auth");
      assert.strictEqual((await stored()).tokens, undefined, "the rejected grant is dropped from the store");
      assert.deepStrictEqual(await listed(), ["call_tool", "list_tools"]);
      const viaList = await client.callTool({ name: "list_tools", arguments: { prefix: "fake__e" } });
      assert.ok((viaList.content as TextContent[])[0].text.includes("No tools found"));
      fake.behaviour.refreshFailure = undefined;
    });

    await test("reauthorization keeps a compatible client registration", async () => {
      const registrations = fake.counts.register;
      assert.strictEqual((await authorize()).status, 200);
      assert.strictEqual(fake.counts.register, registrations);
      assert.strictEqual(status("fake"), "connected");
    });

    await test("invalid_client: registration dropped and replaced, needs-auth", async () => {
      const oldClient = (await stored()).clientInformation.client_id;
      fake.behaviour.refreshFailure = "invalid_client";
      fake.expireAccessTokens();
      const r = await call("fake__echo");
      fake.behaviour.refreshFailure = undefined;
      assert.ok(r.text.includes("needs authorization"), r.text);
      const record = await stored();
      assert.strictEqual(record.tokens, undefined);
      assert.notStrictEqual(record.clientInformation?.client_id, oldClient, "the rejected client is not reused");
      assert.strictEqual((await authorize()).status, 200);
      assert.strictEqual(status("fake"), "connected");
    });

    await test("repeated 401 after a successful refresh: one refresh, then needs-auth", async () => {
      fake.behaviour.always401 = true;
      const refreshes = fake.counts.refreshGrant;
      const r = await call("fake__echo");
      fake.behaviour.always401 = false;
      assert.ok(r.text.includes("needs authorization"), r.text);
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
      assert.strictEqual(status("fake"), "needs-auth");
      assert.strictEqual((await authorize()).status, 200);
    });

    await test("callback replay is refused", async () => {
      const s = await start();
      const callbackUrl = await consent(s.headers.get("location")!);
      assert.strictEqual((await fetch(callbackUrl)).status, 200);
      const codeGrants = fake.counts.codeGrant;
      const replay = await fetch(callbackUrl);
      assert.strictEqual(replay.status, 400);
      assert.strictEqual(fake.counts.codeGrant, codeGrants, "a replay never reaches the token endpoint");
    });

    await test("concurrent starts: only the last state is honoured; concurrent callbacks: one exchange", async () => {
      const [first, second] = await Promise.all([start(), start()]);
      assert.strictEqual(first.status, 303);
      assert.strictEqual(second.status, 303);
      const firstCallback = await consent(first.headers.get("location")!);
      const secondCallback = await consent(second.headers.get("location")!);
      const states = [firstCallback, secondCallback].map((u) => new URL(u).searchParams.get("state"));
      // Starts are serialized: whichever ran last owns the live state.
      const results = await Promise.all([fetch(firstCallback), fetch(secondCallback)]);
      assert.notStrictEqual(states[0], states[1]);
      assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 400]);

      const s = await start();
      const callbackUrl = await consent(s.headers.get("location")!);
      const codeGrants = fake.counts.codeGrant;
      const both = await Promise.all([fetch(callbackUrl), fetch(callbackUrl)]);
      assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 400]);
      assert.strictEqual(fake.counts.codeGrant, codeGrants + 1);
      assert.strictEqual(status("fake"), "connected");
    });

    await test("call in flight during a replacement completes; catalog replaced; neighbours intact", async () => {
      fake.behaviour.tools = ["echo", "slow", "list_cities", "extra"];
      const slow = call("fake__slow");
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await authorize()).status, 200);
      const result = await slow;
      assert.ok(!result.isError, result.text);
      const listing = await client.callTool({ name: "list_tools", arguments: { prefix: "fake__" } });
      const names = JSON.parse((listing.content as TextContent[])[0].text).map((t: { name: string }) => t.name).sort();
      assert.deepStrictEqual(names, ["fake__echo", "fake__extra", "fake__get_forecast", "fake__list_cities", "fake__slow"]);
      assert.ok((await call("fake__list_cities")).text.includes("paris"), "weather still owns the colliding name");
      assert.ok(!(await call("fake__get_forecast", { city: "paris" })).isError);
      assert.deepStrictEqual(await listed(), ["call_tool", "fake__echo", "list_tools"]);
    });

    await test("connect is refused without Origin or from a foreign Origin", async () => {
      const before = fake.counts.authorize + fake.counts.register;
      for (const origin of [null, "https://evil.example", `http://localhost:${port}`]) {
        const r = await start("fake", origin);
        assert.strictEqual(r.status, 403, `${origin}: ${r.status}`);
        assert.strictEqual(r.headers.get("location"), null);
      }
      assert.strictEqual(fake.counts.authorize + fake.counts.register, before);
      assert.strictEqual(status("fake"), "connected", "a refused start does not touch the grant");
    });

    await test("browser routes: Host allowlist, methods, unknown servers", async () => {
      assert.strictEqual((await raw(port, { path: "/", headers: { Host: "evil.example" } })).status, 403);
      assert.strictEqual((await raw(port, { path: "/", headers: { Host: `localhost:${port}` } })).status, 200);
      assert.strictEqual((await raw(port, { path: "/oauth/callback?state=x", headers: { Host: "evil.example" } })).status, 403);
      assert.strictEqual((await fetch(`${hubOrigin}/oauth/start/fake`)).status, 405);
      assert.strictEqual((await fetch(`${hubOrigin}/`, { method: "POST" })).status, 405);
      assert.strictEqual((await fetch(`${hubOrigin}/oauth/callback`, { method: "POST" })).status, 405);
      assert.strictEqual((await start("weather")).status, 404);
      assert.strictEqual((await start("nope")).status, 404);
    });

    await test("other paths still go through the bearer gate, /mcp unchanged", async () => {
      for (const path of ["/oauth", "/oauth/start", "/oauth/start/fake/x", "/status", "/mcp"]) {
        const r = await raw(port, { path, method: "POST" });
        assert.strictEqual(r.status, 401, path);
      }
      const evil = await raw(port, { path: "/mcp", method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } });
      assert.strictEqual(evil.status, 403, "/mcp keeps its loopback Host validation");
    });

    await test("callback parameters are strict and never echoed", async () => {
      const s = await start();
      const good = new URL(await consent(s.headers.get("location")!));
      const state = good.searchParams.get("state")!;
      const variants = [
        `?state=${state}`,
        `?code=abc`,
        `?state=${state}&code=a&code=b`,
        `?state=${state}&code=a&error=x`,
        `?state=${state}&code=a&extra=<script>`,
        `?state=short&code=a`,
      ];
      for (const v of variants) {
        const r = await fetch(`${hubOrigin}/oauth/callback${v}`);
        const body = await r.text();
        assert.strictEqual(r.status, 400, v);
        assert.ok(!body.includes("<script>") && !body.includes(state), v);
      }
      // Rejected shapes did not consume the state: the real callback still works.
      assert.strictEqual((await fetch(good)).status, 200);
    });

    await test("provider denial consumes the state and leaves the child as it was", async () => {
      const s = await start();
      const state = new URL(await consent(s.headers.get("location")!)).searchParams.get("state")!;
      const denied = await fetch(`${hubOrigin}/oauth/callback?state=${state}&error=access_denied&error_description=no`);
      assert.strictEqual(denied.status, 400);
      assert.strictEqual((await fetch(`${hubOrigin}/oauth/callback?state=${state}&code=x`)).status, 400);
    });

    await test("an authorization URL outside the approved origins is never handed out", async () => {
      fake.behaviour.authorizationEndpoint = "https://evil.example/authorize";
      const r = await start();
      fake.behaviour.authorizationEndpoint = undefined;
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.headers.get("location"), null);
    });

    await test("restart: the stored grant connects without a new authorization", async () => {
      assert.strictEqual((await authorize()).status, 200);
      const authorizations = fake.counts.authorize;
      await new Promise((r) => http.close(r));
      http.closeAllConnections();
      await hub.stop();
      hub = new Hub();
      await hub.start(config);
      http = await startHttp(hub, { host: "127.0.0.1", port }, new Map([["test", TOKEN]]));
      assert.strictEqual(status("fake"), "connected");
      assert.strictEqual(fake.counts.authorize, authorizations);
      const fresh = await mcp();
      const r = await fresh.callTool({ name: "fake__echo", arguments: {} });
      assert.ok(!r.isError);
      await fresh.close();
    });
  } finally {
    await client.close().catch(() => {});
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
    await hub.stop();
    await fake.stop();
    await rm(storeDir, { recursive: true, force: true });
  }

  finish();
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
