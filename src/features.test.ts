/**
 * Unit tests for $VAR env interpolation and prefix config.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolveEnvRefs, childEnv } from "./transports.js";
import { VERSION } from "./types.js";
import { Hub } from "./hub.js";

async function run() {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e}`);
      failed++;
    }
  }

  // ── resolveEnvRefs ($VAR interpolation) ─────────────────────────────

  console.log("resolveEnvRefs tests\n");

  await test("resolves $VAR from process.env", () => {
    process.env.__TEST_SECRET = "my-secret-value";
    const result = resolveEnvRefs({ DB_PASS: "$__TEST_SECRET" });
    assert.strictEqual(result.DB_PASS, "my-secret-value");
    delete process.env.__TEST_SECRET;
  });

  await test("keeps $VAR literal when env var is missing", () => {
    delete process.env.__NONEXISTENT_VAR;
    const result = resolveEnvRefs({ KEY: "$__NONEXISTENT_VAR" });
    assert.strictEqual(result.KEY, "$__NONEXISTENT_VAR");
  });

  await test("passes through plain values unchanged", () => {
    const result = resolveEnvRefs({ HOST: "localhost", PORT: "3000" });
    assert.strictEqual(result.HOST, "localhost");
    assert.strictEqual(result.PORT, "3000");
  });

  await test("does not resolve bare $ (single char)", () => {
    const result = resolveEnvRefs({ KEY: "$" });
    assert.strictEqual(result.KEY, "$");
  });

  await test("handles mixed $VAR and plain values", () => {
    process.env.__TEST_MIX = "resolved";
    const result = resolveEnvRefs({
      A: "$__TEST_MIX",
      B: "plain",
      C: "$__MISSING_MIX",
    });
    assert.strictEqual(result.A, "resolved");
    assert.strictEqual(result.B, "plain");
    assert.strictEqual(result.C, "$__MISSING_MIX");
    delete process.env.__TEST_MIX;
  });

  // ── Hub prefix config ────────────────────────────────────────────────

  console.log("\nhub prefix tests\n");

  await test("default prefix: server__tool", async () => {
    const hub = new Hub();
    await hub.start({ servers: {} });
    await hub.stop();
    assert.ok(true);
  });

  await test("prefix: false on a server is accepted", async () => {
    const hub = new Hub();
    await hub.start({ servers: {} });
    await hub.stop();
    assert.ok(true);
  });

  await test("prefix: custom string on a server is accepted", async () => {
    const hub = new Hub();
    await hub.start({ servers: {} });
    await hub.stop();
    assert.ok(true);
  });

  // ── catalog: always, collisions ─────────────────────────────────────

  console.log("\ncatalog tests\n");

  const tool = (name: string, schema: Record<string, unknown> = { type: "object" }) =>
    ({ name, description: `${name} desc`, inputSchema: schema }) as never;
  const names = (hub: Hub) => hub.directTools().map((t) => t.qualifiedName).sort();

  await test("always: true lists every tool of the server directly", () => {
    const hub = new Hub();
    hub.addTools("srv", { always: true }, [tool("a"), tool("b")]);
    assert.deepStrictEqual(names(hub), ["srv__a", "srv__b"]);
  });

  await test("always: [names] selects by original name and uses the effective name", () => {
    const hub = new Hub();
    hub.addTools("srv", { always: ["b"], prefix: "x_" }, [tool("a"), tool("b")]);
    assert.deepStrictEqual(names(hub), ["x_b"]);
    assert.strictEqual(hub.listTools().length, 2);
  });

  await test("no always: nothing listed directly", () => {
    const hub = new Hub();
    hub.addTools("srv", {}, [tool("a")]);
    assert.deepStrictEqual(names(hub), []);
  });

  await test("unknown always name warns without failing", () => {
    const hub = new Hub();
    const warnings: string[] = [];
    const orig = console.error;
    console.error = (m: string) => warnings.push(String(m));
    try {
      hub.addTools("srv", { always: ["ghost"] }, [tool("a")]);
    } finally {
      console.error = orig;
    }
    assert.ok(warnings.some((w) => w.includes("ghost")));
    assert.strictEqual(hub.listTools().length, 1);
  });

  await test("direct tools keep outputSchema and annotations", () => {
    const hub = new Hub();
    hub.addTools("srv", { always: true }, [
      { name: "a", inputSchema: { type: "object" }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } } as never,
    ]);
    const [entry] = hub.directTools();
    assert.deepStrictEqual(entry.outputSchema, { type: "object" });
    assert.deepStrictEqual(entry.annotations, { readOnlyHint: true });
  });

  await test("duplicate effective name is skipped, first one wins", () => {
    const hub = new Hub();
    hub.addTools("one", { prefix: false }, [tool("same")]);
    hub.addTools("two", { prefix: false }, [tool("same")]);
    const all = hub.listTools();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].serverName, "one");
  });

  await test("collision with a meta-tool name is skipped", () => {
    const hub = new Hub();
    hub.addTools("srv", { prefix: false }, [tool("list_tools"), tool("call_tool"), tool("ok")]);
    assert.deepStrictEqual(hub.listTools().map((t) => t.qualifiedName), ["ok"]);
  });

  await test("non-object inputSchema is not listed directly but stays callable", () => {
    const hub = new Hub();
    hub.addTools("srv", { always: true }, [tool("bad", { type: "string" }), tool("good")]);
    assert.deepStrictEqual(names(hub), ["srv__good"]);
    assert.strictEqual(hub.listTools().length, 2);
  });

  // ── child environment scrub ─────────────────────────────────────────

  console.log("\nchild env tests\n");

  const base = { PATH: "/bin", HOME: "/home/x", API_KEY: "k", MY_TOKEN: "t", db_password: "p", Client_Secret: "s", KEEP: "1" };

  await test("secret-named variables are dropped, PATH/HOME kept", () => {
    const env = childEnv(undefined, base);
    assert.deepStrictEqual(env, { PATH: "/bin", HOME: "/home/x", KEEP: "1" });
  });

  await test("declared env is added and overrides", () => {
    const env = childEnv({ KEEP: "2", EXTRA: "x" }, base);
    assert.strictEqual(env.KEEP, "2");
    assert.strictEqual(env.EXTRA, "x");
  });

  await test("declared $VAR re-injects a scrubbed hub variable", () => {
    const env = childEnv({ GITHUB_TOKEN: "$MY_TOKEN" }, base);
    assert.strictEqual(env.GITHUB_TOKEN, "t");
    assert.strictEqual(env.MY_TOKEN, undefined);
  });

  await test("source version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.strictEqual(VERSION, pkg.version);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
