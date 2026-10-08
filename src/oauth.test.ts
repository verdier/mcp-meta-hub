/**
 * OAuth unit tests: config, credential store, broker, provider, network policy.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { ConfigSchema, loadConfig } from "./config.js";
import { AuthorizationBroker, FlowRefusedError } from "./oauth/broker.js";
import { createNetworkPolicy, isPublicAddress } from "./oauth/network.js";
import { OAuthChild } from "./oauth/child.js";
import { HubOAuthProvider } from "./oauth/provider.js";
import { CredentialStore, STORE_FILE } from "./oauth/store.js";
import { createRunner } from "./test-runner.js";

const endpoint = "https://mcp.example/mcp";
const redirect = new URL("https://hub.example/oauth/callback");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mcp-hub-unit-"));
  try {
    await fn(join(root, "oauth"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const issues = (value: unknown) => {
  const r = ConfigSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

async function run() {
  const { test, finish } = createRunner();
  console.log("OAuth unit tests\n");

  // --- config ---

  const http = (extra: object = {}) => ({ transport: "streamable-http", url: endpoint, ...extra });
  const global = { redirectUrl: redirect.toString() };

  await test("config: oauth true or options on a streamable-http child", () => {
    assert.deepStrictEqual(issues({ servers: { a: http({ oauth: true }) }, oauth: global }), []);
    assert.deepStrictEqual(issues({
      servers: { a: http({ oauth: { scopes: ["read"], clientId: "id", clientName: "n", allowedOrigins: ["https://auth.example"], allowPrivateNetwork: true } }) },
      oauth: global,
    }), []);
  });

  await test("config: oauth on a stdio or SSE child is an error", () => {
    const stdio = issues({ servers: { a: { command: "x", oauth: true } }, oauth: global });
    assert.ok(stdio.some((i) => i.startsWith("servers.a.oauth: ") && i.includes("streamable-http")), stdio.join());
    const sse = issues({ servers: { a: { transport: "sse", url: endpoint, oauth: true } }, oauth: global });
    assert.ok(sse.some((i) => i.startsWith("servers.a.oauth")), sse.join());
  });

  await test("config: a child oauth without the global oauth.redirectUrl is an error", () => {
    const r = issues({ servers: { a: http({ oauth: true }) } });
    assert.ok(r.some((i) => i.includes("redirectUrl")), r.join());
  });

  await test("config: redirectUrl must be https (http on loopback) and end in /oauth/callback", () => {
    for (const bad of ["http://hub.example/oauth/callback", "https://hub.example/callback", "https://hub.example/oauth/callback?x=1", "https://u:p@hub.example/oauth/callback"]) {
      assert.ok(issues({ servers: {}, oauth: { redirectUrl: bad } }).length > 0, bad);
    }
    for (const good of ["https://hub.example/oauth/callback", "http://127.0.0.1:4000/oauth/callback", "http://localhost:4000/oauth/callback"]) {
      assert.deepStrictEqual(issues({ servers: {}, oauth: { redirectUrl: good } }), [], good);
    }
  });

  await test("config: allowedOrigins entries must be bare origins", () => {
    const with_ = (allowedOrigins: string[]) => issues({ servers: { a: http({ oauth: { allowedOrigins } }) }, oauth: global });
    for (const bad of ["https://auth.example/path", "https://auth.example?x=1", "https://auth.example#f", "https://u:p@auth.example", "ftp://auth.example", "auth.example", ""]) {
      assert.ok(with_([bad]).some((i) => i.includes("allowedOrigins")), bad);
    }
    for (const good of ["https://auth.example", "https://auth.example/", "http://127.0.0.1:8080"]) {
      assert.deepStrictEqual(with_([good]), [], good);
    }
  });

  await test("config: unknown child oauth options are rejected", () => {
    assert.ok(issues({ servers: { a: http({ oauth: { clientSecret: "x" } }) }, oauth: global }).length > 0);
  });

  await test("config: storeDir defaults to oauth/ next to the config file", async () => {
    await withDir(async (dir) => {
      await mkdir(dir, { recursive: true });
      const path = join(dir, "hub.json");
      await writeFile(path, JSON.stringify({ servers: {}, oauth: global }));
      assert.strictEqual((await loadConfig(path)).oauth?.storeDir, join(dir, "oauth"));
      await writeFile(path, JSON.stringify({ servers: {}, oauth: { ...global, storeDir: "../creds" } }));
      assert.strictEqual((await loadConfig(path)).oauth?.storeDir, join(dir, "..", "creds"));
    });
  });

  // --- store ---

  await test("store: survives a new instance, 0700 directory, 0600 file", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      await store.update("a", (r) => ({ ...r!, tokens: { access_token: "at", refresh_token: "rt", token_type: "bearer" } }));
      assert.deepStrictEqual((await new CredentialStore(dir).load("a"))?.tokens?.refresh_token, "rt");
      assert.strictEqual((await lstat(dir)).mode & 0o777, 0o700);
      assert.strictEqual((await lstat(join(dir, STORE_FILE))).mode & 0o777, 0o600);
      assert.deepStrictEqual(await readdir(dir), [STORE_FILE], "no temporary file left behind");
    });
  });

  await test("store: after the first read nothing touches the disk; every write replaces the cached copy", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      await store.update("a", (r) => ({ ...r!, tokens: { access_token: "at", refresh_token: "rt", token_type: "bearer" } }));
      await rm(join(dir, STORE_FILE));
      assert.strictEqual((await store.load("a"))?.tokens?.refresh_token, "rt", "served from memory");
      const copy = await store.load("a");
      copy!.tokens!.access_token = "tampered";
      assert.strictEqual((await store.load("a"))?.tokens?.access_token, "at", "callers get copies");
      await store.update("a", (r) => ({ ...r!, tokens: { access_token: "at2", token_type: "bearer" } }));
      assert.strictEqual((await new CredentialStore(dir).load("a"))?.tokens?.access_token, "at2", "and the file follows");
    });
  });

  await test("store: a file or directory swapped for a symlink after the first write is refused at the next write", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const elsewhere = join(dir, "..", "elsewhere");
      await writeFile(elsewhere, "{}");
      await rm(join(dir, STORE_FILE));
      await symlink(elsewhere, join(dir, STORE_FILE));
      await assert.rejects(store.update("a", (r) => ({ ...r!, clientInformation: { client_id: "x" } })), /unsafe/);
      assert.strictEqual(await readFile(elsewhere, "utf8"), "{}", "nothing was written through the link");
      await rm(join(dir, STORE_FILE));
      await writeFile(join(dir, STORE_FILE), "");
      await rm(dir, { recursive: true });
      await mkdir(join(dir, "..", "target"));
      await symlink(join(dir, "..", "target"), dir);
      await assert.rejects(store.update("a", (r) => ({ ...r!, clientInformation: { client_id: "x" } })), /unsafe/);
      assert.deepStrictEqual(await readdir(join(dir, "..", "target")), [], "no credential file landed in the target");
    });
  });

  await test("store: concurrent updates of different fields and servers are all kept", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await Promise.all([store.prepare("a", endpoint), store.prepare("b", endpoint)]);
      await Promise.all([
        store.update("a", (r) => ({ ...r!, clientInformation: { client_id: "client" } })),
        store.update("a", (r) => ({ ...r!, tokens: { access_token: "at", token_type: "bearer" } })),
        store.update("b", (r) => ({ ...r!, tokens: { access_token: "bt", token_type: "bearer" } })),
      ]);
      const a = await store.load("a");
      assert.strictEqual(a?.clientInformation?.client_id, "client");
      assert.strictEqual(a?.tokens?.access_token, "at");
      assert.strictEqual((await store.load("b"))?.tokens?.access_token, "bt");
    });
  });

  await test("store: a changed endpoint drops the record", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      await store.update("a", (r) => ({ ...r!, tokens: { access_token: "old-at", token_type: "bearer" } }));
      await store.prepare("a", endpoint);
      assert.ok((await store.load("a"))?.tokens, "same endpoint keeps it");
      await store.prepare("a", "https://other.example/mcp");
      assert.deepStrictEqual(await store.load("a"), { endpoint: "https://other.example/mcp" });
      assert.ok(!(await readFile(join(dir, STORE_FILE), "utf8")).includes("old-at"));
    });
  });

  await test("store: corrupt JSON fails closed, a symlinked file is refused", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await writeFile(join(dir, STORE_FILE), "{bad");
      await assert.rejects(store.load("a"), /corrupt/);
      await rm(join(dir, STORE_FILE));
      await symlink("/etc/hostname", join(dir, STORE_FILE));
      assert.throws(() => new CredentialStore(dir), /unsafe/);
    });
  });

  // --- broker ---

  const flow = (broker: AuthorizationBroker, key: string, verifier = `verifier-${key}`) => {
    const state = broker.issueState(key);
    broker.setVerifier(key, state, verifier);
    return state;
  };
  const refusal = (reason: "superseded" | "invalid") => (e: unknown) => e instanceof FlowRefusedError && e.reason === reason;

  await test("broker: a state is honoured once, with the verifier of its own flow", () => {
    const broker = new AuthorizationBroker();
    const state = flow(broker, "a");
    assert.strictEqual(broker.serverOf(state), "a");
    assert.deepStrictEqual(broker.consume(state), { key: "a", verifier: "verifier-a" });
    assert.strictEqual(broker.serverOf(state), undefined);
    assert.throws(() => broker.consume(state), refusal("invalid"));
  });

  await test("broker: an expired state is refused (and consumed)", () => {
    let now = 1_000;
    const broker = new AuthorizationBroker(() => now);
    const state = flow(broker, "a");
    broker.publishAuthorization("a", state, new URL("https://auth.example/authorize"));
    now += 10 * 60_000;
    assert.strictEqual(broker.authorizationUrl("a"), undefined);
    assert.throws(() => broker.consume(state), refusal("invalid"));
    assert.throws(() => broker.consume(state), refusal("invalid"));
  });

  await test("broker: a new state supersedes the previous one of the same server only, and says so", () => {
    const broker = new AuthorizationBroker();
    const first = flow(broker, "a", "first");
    const other = flow(broker, "b");
    const second = flow(broker, "a", "second");
    assert.strictEqual(broker.serverOf(first), "a", "a superseded state still names its server");
    assert.throws(() => broker.consume(first), refusal("superseded"));
    assert.throws(() => broker.consume(first), refusal("invalid"));
    assert.deepStrictEqual(broker.consume(second), { key: "a", verifier: "second" });
    assert.deepStrictEqual(broker.consume(other), { key: "b", verifier: "verifier-b" });
  });

  await test("broker: publishing or setting a verifier with a stale or unknown state throws", () => {
    const broker = new AuthorizationBroker();
    const first = broker.issueState("a");
    broker.issueState("a");
    assert.throws(() => broker.publishAuthorization("a", first, new URL("https://auth.example/")));
    assert.throws(() => broker.publishAuthorization("z", first, new URL("https://auth.example/")));
    assert.throws(() => broker.setVerifier("a", first, "v"));
  });

  // --- provider ---

  const provider = (store: CredentialStore, broker = new AuthorizationBroker(), clientId?: string) =>
    new HubOAuthProvider("a", { clientId, scopes: ["read"], clientName: "hub" }, store, broker, redirect, async () => undefined);

  await test("provider: public client metadata with the redirect URL and scopes", async () => {
    await withDir(async (dir) => {
      const m = provider(new CredentialStore(dir)).clientMetadata;
      assert.deepStrictEqual(m.redirect_uris, [redirect.toString()]);
      assert.strictEqual(m.token_endpoint_auth_method, "none");
      assert.strictEqual(m.scope, "read");
    });
  });

  await test("provider: saveTokens stores what the SDK hands over (it preserves the refresh token itself); the verifier is never stored", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const broker = new AuthorizationBroker();
      const p = provider(store, broker);
      p.interactive = true;
      p.state();
      p.saveCodeVerifier("verifier-123");
      await p.saveTokens({ access_token: "a1", refresh_token: "r1", token_type: "bearer" });
      await p.saveTokens({ access_token: "a2", token_type: "bearer" });
      assert.deepStrictEqual(await p.tokens(), { access_token: "a2", token_type: "bearer" });
      assert.throws(() => p.codeVerifier(), /verifier/, "only an exchange in progress has a verifier");
      assert.ok(!(await readFile(store.filePath, "utf8")).includes("verifier-123"));
    });
  });

  await test("provider: the verifier of an exchange is the one it was given, not the last one saved", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const broker = new AuthorizationBroker();
      const p = provider(store, broker);
      p.interactive = true;
      const first = p.state();
      p.saveCodeVerifier("first");
      p.state();
      p.saveCodeVerifier("second");
      assert.throws(() => broker.consume(first), refusal("superseded"));
      p.exchangeVerifier = "first";
      assert.strictEqual(p.codeVerifier(), "first");
    });
  });

  await test("provider: background mode publishes nothing and cancels nothing", async () => {
    await withDir(async (dir) => {
      const broker = new AuthorizationBroker();
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const p = provider(store, broker);
      const pending = flow(broker, "a");
      p.state();
      p.saveCodeVerifier("background");
      await p.redirectToAuthorization(new URL("https://auth.example/authorize"));
      assert.strictEqual(broker.authorizationUrl("a"), undefined);
      assert.deepStrictEqual(broker.consume(pending), { key: "a", verifier: "verifier-a" }, "a background refresh never cancels a pending authorization");
    });
  });

  await test("provider: background redirect with a refresh token still stored is an outage, not a reason to ask for consent", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const p = provider(store);
      await p.redirectToAuthorization(new URL("https://auth.example/authorize"));
      await p.saveTokens({ access_token: "a", refresh_token: "r", token_type: "bearer" });
      await assert.rejects(p.redirectToAuthorization(new URL("https://auth.example/authorize")), /unavailable/);
    });
  });

  await test("provider: invalidateCredentials clears fields but keeps the endpoint binding", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const p = provider(store);
      await p.saveClientInformation({ client_id: "c" });
      await p.saveTokens({ access_token: "a", refresh_token: "r", token_type: "bearer" });
      await p.invalidateCredentials("tokens");
      assert.deepStrictEqual(await store.load("a"), { endpoint, clientInformation: { client_id: "c" } });
      await p.invalidateCredentials("all");
      assert.deepStrictEqual(await store.load("a"), { endpoint });
    });
  });

  await test("provider: a configured clientId wins over any stored registration", async () => {
    await withDir(async (dir) => {
      const store = new CredentialStore(dir);
      await store.prepare("a", endpoint);
      const p = provider(store, undefined, "preset");
      await p.saveClientInformation({ client_id: "registered" });
      assert.deepStrictEqual(await p.clientInformation(), { client_id: "preset" });
    });
  });

  // --- child queue ---

  await test("child queue: one item at a time; a timeout answers the caller and aborts the item, the queue moves on only when the work has settled", async () => {
    await withDir(async (dir) => {
      const child = new OAuthChild("a", endpoint, {}, {
        broker: new AuthorizationBroker(),
        store: new CredentialStore(dir),
        redirectUrl: redirect,
        pageUrl: "https://hub.example/",
      });
      const events: string[] = [];
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let aborted = false;
      const stuck = child.run(async (signal) => {
        events.push("stuck:start");
        await sleep(300); // work that ignores its signal
        aborted = signal.aborted;
        events.push("stuck:end");
      }, 50);
      const next = child.run(async () => {
        events.push("next:start");
        return "ok";
      }, 1_000);
      const started = Date.now();
      await assert.rejects(stuck, /timed out/);
      assert.ok(Date.now() - started < 250, "the caller was answered at the timeout");
      assert.deepStrictEqual(events, ["stuck:start"], "the next item is still waiting");
      assert.strictEqual(await next, "ok");
      assert.deepStrictEqual(events, ["stuck:start", "stuck:end", "next:start"]);
      assert.ok(aborted, "the item was told to stop");
    });
  });

  // --- network policy ---

  const policy = (opts: {
    origins?: string[];
    addresses?: string[];
    allowPrivateNetwork?: boolean;
    respond?: (url: URL, init: RequestInit) => Response;
  }) => {
    const requests: Array<{ url: string; headers: string[] }> = [];
    const network = createNetworkPolicy({
      approvedOrigins: opts.origins ?? ["https://mcp.example"],
      allowPrivateNetwork: opts.allowPrivateNetwork,
      resolveHost: async () => (opts.addresses ?? ["93.184.216.34"]).map((address) => ({ address })),
      request: async (url, init) => {
        requests.push({ url: url.toString(), headers: Array.from(new Headers(init.headers).keys()).sort() });
        return opts.respond?.(url, init) ?? new Response("ok");
      },
    });
    return { network, requests };
  };

  await test("network: private, loopback and link-local answers are refused before any request", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      const { network, requests } = policy({ addresses: [address] });
      await assert.rejects(network.fetch("https://mcp.example/mcp"), /non-public/, address);
      assert.strictEqual(requests.length, 0, address);
    }
    assert.ok(isPublicAddress("93.184.216.34") && isPublicAddress("2606:4700::1"));
  });

  await test("network: special-purpose IPv6 and IPv4 ranges are not public, their neighbours are", () => {
    for (const address of ["100::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:db8::1", "2001:1ff::1", "2002::1", "3fff::1", "5f00::1",
      "64:ff9b::808:808", "64:ff9b:1::1", "::", "::1", "::ffff:8.8.8.8", "fe80::1", "fec0::1", "fc00::1", "ff02::1", "4000::1", "198.51.100.7", "192.0.2.1", "192.0.0.9", "203.0.113.5", "198.18.0.1", "240.0.0.1"]) {
      assert.strictEqual(isPublicAddress(address), false, address);
    }
    for (const address of ["2001:200::1", "2001:4860:4860::8888", "2a00:1450:4001::1", "3fff:1000::1", "198.51.101.7", "198.51.0.1", "192.0.3.1", "198.17.0.1", "198.20.0.1"]) {
      assert.strictEqual(isPublicAddress(address), true, address);
    }
    assert.throws(() => isPublicAddress("example.com"), /Not an IP/);
    assert.throws(() => isPublicAddress(""), /Not an IP/);
  });

  await test("network: one private answer among public ones is enough to refuse", async () => {
    const { network } = policy({ addresses: ["93.184.216.34", "10.0.0.1"] });
    await assert.rejects(network.fetch("https://mcp.example/mcp"), /non-public/);
  });

  await test("network: http, credentials, fragments and unapproved origins are refused", async () => {
    const { network, requests } = policy({});
    for (const url of ["http://mcp.example/mcp", "https://user:pw@mcp.example/mcp", "https://mcp.example/mcp#x", "https://other.example/mcp"]) {
      await assert.rejects(network.fetch(url), Error, url);
      await assert.rejects(network.assertUrl(new URL(url)), Error, url);
    }
    assert.strictEqual(requests.length, 0);
  });

  await test("network: allowPrivateNetwork admits private addresses, plain HTTP only to them", async () => {
    const local = policy({ origins: ["http://127.0.0.1:9"], allowPrivateNetwork: true });
    assert.strictEqual(await (await local.network.fetch("http://127.0.0.1:9/mcp")).text(), "ok");
    const pub = policy({ origins: ["http://mcp.example"], allowPrivateNetwork: true });
    await assert.rejects(pub.network.fetch("http://mcp.example/mcp"), /plain HTTP/);
  });

  await test("network: a redirect off the allowlist is refused before the next request", async () => {
    const { network, requests } = policy({
      respond: () => new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } }),
    });
    await assert.rejects(network.fetch("https://mcp.example/.well-known/x"), /origin/);
    assert.strictEqual(requests.length, 1);
  });

  await test("network: a redirect to a private address is refused", async () => {
    let n = 0;
    const network = createNetworkPolicy({
      approvedOrigins: ["https://mcp.example", "https://auth.example"],
      resolveHost: async (host) => [{ address: host === "auth.example" ? "10.0.0.5" : "93.184.216.34" }],
      request: async () => {
        n++;
        return new Response(null, { status: 302, headers: { location: "https://auth.example/" } });
      },
    });
    await assert.rejects(network.fetch("https://mcp.example/"), /non-public/);
    assert.strictEqual(n, 1);
  });

  await test("network: no redirect for a non-idempotent request", async () => {
    const { network, requests } = policy({
      respond: () => new Response(null, { status: 307, headers: { location: "https://mcp.example/other" } }),
    });
    await assert.rejects(network.fetch("https://mcp.example/token", { method: "POST", body: "x" }), /non-idempotent/);
    assert.strictEqual(requests.length, 1);
  });

  await test("network: a cross-origin redirect keeps only accept and content-type; redirect count is bounded", async () => {
    const { network, requests } = policy({
      origins: ["https://mcp.example", "https://auth.example"],
      respond: (url) => url.origin === "https://mcp.example"
        ? new Response(null, { status: 302, headers: { location: "https://auth.example/meta" } })
        : new Response("meta"),
    });
    const headers = { Authorization: "Bearer t", Cookie: "s=1", "X-Api-Key": "k", "Proxy-Authorization": "p", "X-Custom": "c", Accept: "application/json", "Content-Type": "text/plain" };
    assert.strictEqual(await (await network.fetch("https://mcp.example/meta", { headers })).text(), "meta");
    assert.deepStrictEqual(requests.map((r) => r.headers), [
      ["accept", "authorization", "content-type", "cookie", "proxy-authorization", "x-api-key", "x-custom"],
      ["accept", "content-type"],
    ]);
    // Same origin: nothing is dropped.
    const same = policy({ respond: (url) => url.pathname === "/a" ? new Response(null, { status: 302, headers: { location: "/b" } }) : new Response("b") });
    await same.network.fetch("https://mcp.example/a", { headers: { Authorization: "Bearer t" } });
    assert.deepStrictEqual(same.requests.map((r) => r.headers.includes("authorization")), [true, true]);

    const loop = policy({ respond: () => new Response(null, { status: 302, headers: { location: "/again" } }) });
    await assert.rejects(loop.network.fetch("https://mcp.example/"), /limit/);
    assert.strictEqual(loop.requests.length, 4);
  });

  finish();
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
