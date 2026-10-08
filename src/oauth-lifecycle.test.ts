/**
 * OAuth children under races and protocol details: one operation at a time per
 * child, replaced generations, flows bound to their state, timeouts, challenges
 * and step-up, and what reaches the logs. A hub with short timeouts, a fake
 * authorization + MCP server, and the test playing the browser.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Hub } from "./hub.js";
import { startHttp } from "./http.js";
import { FakeOAuthServer } from "./oauth-fake.js";
import { browser, freePort } from "./test-support.js";
import { STORE_FILE } from "./oauth/store.js";
import { createRunner } from "./test-runner.js";
import type { Config } from "./types.js";

const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { test, finish } = createRunner();
  console.log("OAuth lifecycle tests\n");

  const fake = new FakeOAuthServer();
  await fake.start();
  const storeDir = await mkdtemp(join(tmpdir(), "mcp-hub-oauth-life-"));
  const port = await freePort();
  const hubOrigin = `http://127.0.0.1:${port}`;
  const config: Config = {
    servers: { fake: { transport: "streamable-http", url: `${fake.origin}/mcp`, oauth: { allowPrivateNetwork: true } } },
    oauth: { redirectUrl: `${hubOrigin}/oauth/callback`, storeDir },
  };
  const hub = new Hub({ connectTimeoutMs: 5_000, callTimeoutMs: 700 });
  await hub.start(config);
  const http: HttpServer = await startHttp(hub, { host: "127.0.0.1", port }, new Map([["test", "unused"]]));

  const status = () => hub.servers().find((s) => s.name === "fake")!.status;
  const call = (name = "fake__echo") => hub.callTool(name, {});
  const stored = async () => JSON.parse(await readFile(join(storeDir, STORE_FILE), "utf8")).credentials.fake;
  const { start, consent, begin, authorize } = browser(hubOrigin);
  const logs: string[] = [];
  const realError = console.error;
  // The hub's log lines are collected; the runner's own failure report goes through.
  console.error = (...args: unknown[]) => {
    const line = args.join(" ");
    if (line.startsWith("[mcp-meta-hub]")) logs.push(line);
    else realError(...args);
  };

  try {
    assert.strictEqual(status(), "needs-auth");
    assert.strictEqual((await authorize()).status, 200);
    assert.strictEqual(status(), "connected");

    await test("an old call failing with 401 after a replacement leaves the replacement connected", async () => {
      const callback = await begin();
      fake.behaviour.codeDelayMs = 400;
      fake.behaviour.unauthorizedTools = ["echo"];
      const replacing = fetch(callback);
      await sleep(100); // the exchange is running: the call below is queued behind it, on the old client
      const oldCall = call();
      assert.strictEqual((await replacing).status, 200);
      const result = await oldCall;
      fake.behaviour.codeDelayMs = 0;
      fake.behaviour.unauthorizedTools = undefined;
      assert.ok(result.isError, "the old call failed");
      assert.ok(!text(result).includes("needs authorization"));
      assert.strictEqual(status(), "connected");
      assert.ok(!(await call()).isError, "the replacement serves calls");
    });

    await test("concurrent calls on an expired token: one refresh grant, even if the server returns the same access token", async () => {
      fake.behaviour.reuseAccessToken = true;
      fake.behaviour.tokenDelayMs = 100;
      fake.expireAccessTokens();
      assert.ok(!(await call()).isError); // the stored access token is now the one the server will keep issuing
      const sameToken = (await stored()).tokens.access_token;
      const refreshes = fake.counts.refreshGrant;
      fake.expireAccessTokens();
      const results = await Promise.all([1, 2, 3, 4].map(() => call()));
      fake.behaviour.reuseAccessToken = false;
      fake.behaviour.tokenDelayMs = 0;
      assert.ok(results.every((r) => !r.isError), JSON.stringify(results));
      assert.strictEqual((await stored()).tokens.access_token, sameToken);
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
    });

    await test("a timed-out refresh is cancelled and cannot write afterwards; a new authorization succeeds", async () => {
      fake.behaviour.tokenDelayMs = 1_200;
      fake.expireAccessTokens();
      const answered = fake.counts.refreshGrant;
      const timedOut = await call();
      assert.ok(timedOut.isError);
      assert.ok(text(timedOut).includes("timed out"), JSON.stringify(timedOut));
      const before = Date.now();
      assert.strictEqual((await authorize()).status, 200);
      assert.ok(Date.now() - before < 1_000, "the queue did not wait for the cancelled refresh to run its course");
      assert.strictEqual(fake.counts.refreshGrant, answered + 1);
      await sleep(1_400); // the fake finally answers the refresh nobody listens to
      fake.behaviour.tokenDelayMs = 0;
      assert.strictEqual(fake.issuedBy.get((await stored()).tokens.access_token), "code", "no late write over the new grant");
      assert.strictEqual(status(), "connected");
      assert.ok(!(await call()).isError);
    });

    await test("start A, start B, callback A: refused as superseded, never exchanged; callback B succeeds", async () => {
      const a = await begin();
      const b = await begin();
      const grants = fake.counts.codeGrant;
      const refused = await fetch(a);
      assert.strictEqual(refused.status, 400);
      assert.ok((await refused.text()).includes("superseded"));
      assert.strictEqual(fake.counts.codeGrant, grants, "a superseded code is never sent");
      assert.strictEqual((await fetch(b)).status, 200);
      assert.strictEqual(status(), "connected");
    });

    await test("callback A arriving while start B is still running is superseded too, not exchanged with B's verifier", async () => {
      const a = await begin();
      fake.behaviour.metadataDelayMs = 400;
      const startingB = start();
      await sleep(100); // B is running its discovery and has not issued its state yet
      const grants = fake.counts.codeGrant;
      const refused = await fetch(a);
      fake.behaviour.metadataDelayMs = 0;
      assert.strictEqual(refused.status, 400);
      assert.ok((await refused.text()).includes("superseded"));
      assert.strictEqual(fake.counts.codeGrant, grants);
      const b = await startingB;
      assert.strictEqual((await fetch(await consent(b.headers.get("location")!))).status, 200);
      assert.strictEqual(status(), "connected");
    });

    await test("a callback replayed through the browser surface never reaches the token endpoint again", async () => {
      const callback = await begin();
      assert.strictEqual((await fetch(callback)).status, 200);
      const grants = fake.counts.codeGrant;
      assert.strictEqual((await fetch(callback)).status, 400);
      assert.strictEqual(fake.counts.codeGrant, grants);
    });

    await test("a resource_metadata URL given only by the challenge is fetched, and its scope reaches the authorization", async () => {
      fake.behaviour.challengeOnlyMetadata = true;
      fake.behaviour.challengeScope = "special";
      const wellKnown = fake.counts.wellKnownMetadata;
      const challenged = fake.counts.challengeMetadata;
      assert.strictEqual((await authorize()).status, 200);
      fake.behaviour.challengeOnlyMetadata = false;
      fake.behaviour.challengeScope = undefined;
      assert.ok(fake.counts.challengeMetadata > challenged, "the URL from WWW-Authenticate was visited");
      assert.strictEqual(fake.counts.wellKnownMetadata, wellKnown, "no guessing at the well-known path");
      assert.strictEqual(fake.authorizeRequests.at(-1)!.get("scope"), "special");
      assert.strictEqual(status(), "connected");
    });

    await test("403 insufficient_scope: the SDK's step-up runs once and the call goes through", async () => {
      fake.behaviour.scopeGatedTools = ["echo"];
      fake.behaviour.refreshGrantsSpecial = true;
      const refreshes = fake.counts.refreshGrant;
      const result = await call();
      fake.behaviour.scopeGatedTools = undefined;
      fake.behaviour.refreshGrantsSpecial = false;
      assert.ok(!result.isError, JSON.stringify(result));
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
      assert.strictEqual(status(), "connected");
    });

    await test("a raw token endpoint body (a credential echoed back) reaches neither the logs nor the page", async () => {
      const secret = "sentinel-secret-token-9f3a";
      const callback = await begin();
      fake.behaviour.tokenRawBody = `oops ${secret}`;
      logs.length = 0;
      const page = await fetch(callback);
      fake.behaviour.tokenRawBody = undefined;
      assert.strictEqual(page.status, 400);
      assert.ok(!(await page.text()).includes(secret));
      assert.ok(logs.some((l) => l.includes("code exchange failed")), "the failure is logged");
      assert.ok(!logs.some((l) => l.includes(secret)), logs.join("\n"));
      assert.strictEqual((await authorize()).status, 200);
    });

    await test("a reflected MCP error message never reaches the model; its class and code do", async () => {
      const secret = "reflected-sentinel-secret";
      fake.behaviour.echoErrorMessage = secret;
      const result = await call();
      fake.behaviour.echoErrorMessage = undefined;
      assert.ok(result.isError);
      assert.ok(!text(result).includes(secret), text(result));
      assert.ok(text(result).includes("-32603"), text(result));
    });

    await test("the optional GET stream is never opened, so nothing authenticates outside the queue", async () => {
      assert.ok(fake.counts.mcp > 0);
      assert.strictEqual(fake.counts.mcpGet, 0, "no GET ever reached the MCP endpoint");
      const refreshes = fake.counts.refreshGrant;
      fake.expireAccessTokens();
      assert.ok(!(await call()).isError);
      assert.strictEqual(fake.counts.refreshGrant, refreshes + 1);
    });

    await test("a connect that times out in discovery cannot register or write afterwards", async () => {
      const slowFake = new FakeOAuthServer();
      await slowFake.start();
      slowFake.behaviour.prmDelayMs = 500;
      const dir = await mkdtemp(join(tmpdir(), "mcp-hub-oauth-late-"));
      const lateHub = new Hub({ connectTimeoutMs: 100 });
      try {
        await lateHub.start({
          servers: { late: { transport: "streamable-http", url: `${slowFake.origin}/mcp`, oauth: { allowPrivateNetwork: true } } },
          oauth: { redirectUrl: `${hubOrigin}/oauth/callback`, storeDir: dir },
        });
        assert.strictEqual(lateHub.servers()[0]!.status, "failed");
        await sleep(1_000);
        assert.strictEqual(slowFake.counts.register, 0, "no registration after the timeout");
        const record = JSON.parse(await readFile(join(dir, STORE_FILE), "utf8")).credentials.late;
        assert.deepStrictEqual(Object.keys(record), ["endpoint"], "nothing was written");
      } finally {
        await lateHub.stop();
        await slowFake.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  } finally {
    console.error = realError;
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
