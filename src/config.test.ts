/**
 * Unit tests for config validation.
 */
import { strict as assert } from "node:assert";
import { ConfigSchema } from "./config.js";
import { resolveClientTokens, parseHttpAddress } from "./http.js";

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

  console.log("config validation tests\n");

  await test("rejects server names containing '__'", () => {
    const result = ConfigSchema.safeParse({
      servers: { "my__server": { command: "node", args: [] } },
    });
    assert.ok(!result.success);
  });

  await test("rejects server names starting with hyphen", () => {
    const result = ConfigSchema.safeParse({
      servers: { "-bad": { command: "node", args: [] } },
    });
    assert.ok(!result.success);
  });

  await test("rejects server names ending with hyphen", () => {
    const result = ConfigSchema.safeParse({
      servers: { "bad-": { command: "node", args: [] } },
    });
    assert.ok(!result.success);
  });

  await test("rejects server names with special characters", () => {
    const result = ConfigSchema.safeParse({
      servers: { "my server!": { command: "node", args: [] } },
    });
    assert.ok(!result.success);
  });

  await test("accepts valid server names", () => {
    const result = ConfigSchema.safeParse({
      servers: {
        "weather": { command: "node", args: [] },
        "my-api": { command: "node", args: [] },
        "github2": { command: "node", args: [] },
      },
    });
    assert.ok(result.success);
  });

  await test("accepts SSE server config", () => {
    const result = ConfigSchema.safeParse({
      servers: { remote: { url: "http://localhost:3000/sse", transport: "sse" } },
    });
    assert.ok(result.success);
  });

  await test("accepts streamable HTTP server config", () => {
    const result = ConfigSchema.safeParse({
      servers: { remote: { url: "http://localhost:3000/mcp", transport: "streamable-http" } },
    });
    assert.ok(result.success);
  });

  await test("accepts empty servers object", () => {
    const result = ConfigSchema.safeParse({ servers: {} });
    assert.ok(result.success);
  });

  await test("rejects missing servers key", () => {
    const result = ConfigSchema.safeParse({});
    assert.ok(!result.success);
  });

  // ── prefix per-server option ────────────────────────────────────────

  await test("accepts prefix: true on a server", () => {
    const result = ConfigSchema.safeParse({
      servers: { weather: { command: "node", args: [], prefix: true } },
    });
    assert.ok(result.success);
  });

  await test("accepts prefix: false on a server", () => {
    const result = ConfigSchema.safeParse({
      servers: { weather: { command: "node", args: [], prefix: false } },
    });
    assert.ok(result.success);
  });

  await test("accepts prefix: custom string on a server", () => {
    const result = ConfigSchema.safeParse({
      servers: { weather: { command: "node", args: [], prefix: "wx__" } },
    });
    assert.ok(result.success);
  });

  await test("prefix defaults to undefined when omitted", () => {
    const result = ConfigSchema.safeParse({
      servers: { weather: { command: "node", args: [] } },
    });
    assert.ok(result.success);
  });

  // ── always / clients / HTTP mode ────────────────────────────────────

  await test("accepts always: true and always: [names]", () => {
    const result = ConfigSchema.safeParse({
      servers: {
        a: { command: "node", args: [], always: true },
        b: { url: "http://localhost:3000/sse", transport: "sse", always: ["x", "y"] },
        c: { url: "http://localhost:3000/mcp", transport: "streamable-http", always: false },
      },
    });
    assert.ok(result.success);
  });

  await test("rejects malformed always", () => {
    assert.ok(!ConfigSchema.safeParse({ servers: { a: { command: "node", always: "x" } } }).success);
    assert.ok(!ConfigSchema.safeParse({ servers: { a: { command: "node", always: [1] } } }).success);
  });

  await test("accepts clients with tokenEnv, rejects a client without it", () => {
    assert.ok(ConfigSchema.safeParse({ servers: {}, clients: { app: { tokenEnv: "T" } } }).success);
    assert.ok(!ConfigSchema.safeParse({ servers: {}, clients: { app: {} } }).success);
  });

  await test("HTTP mode requires a non-empty clients object", () => {
    assert.throws(() => resolveClientTokens(undefined, {}), /clients/);
    assert.throws(() => resolveClientTokens({}, {}), /clients/);
  });

  await test("client tokens: missing, empty and duplicate are refused", () => {
    assert.throws(() => resolveClientTokens({ a: { tokenEnv: "T_A" } }, {}), /T_A/);
    assert.throws(() => resolveClientTokens({ a: { tokenEnv: "T_A" } }, { T_A: "" }), /T_A/);
    assert.throws(
      () => resolveClientTokens({ a: { tokenEnv: "T_A" }, b: { tokenEnv: "T_B" } }, { T_A: "x", T_B: "x" }),
      /share the same token/,
    );
  });

  await test("client tokens are resolved from the environment", () => {
    const tokens = resolveClientTokens({ a: { tokenEnv: "T_A" }, b: { tokenEnv: "T_B" } }, { T_A: "1", T_B: "2" });
    assert.strictEqual(tokens.get("a"), "1");
    assert.strictEqual(tokens.get("b"), "2");
  });

  await test("--http accepts loopback only", () => {
    assert.deepStrictEqual(parseHttpAddress("127.0.0.1:4000"), { host: "127.0.0.1", port: 4000 });
    assert.deepStrictEqual(parseHttpAddress("localhost:80"), { host: "localhost", port: 80 });
    assert.deepStrictEqual(parseHttpAddress("[::1]:4000"), { host: "::1", port: 4000 });
    assert.throws(() => parseHttpAddress("0.0.0.0:4000"), /loopback/);
    assert.throws(() => parseHttpAddress("192.168.1.2:4000"), /loopback/);
    assert.throws(() => parseHttpAddress("127.0.0.1"), /host:port/);
    assert.throws(() => parseHttpAddress("127.0.0.1:99999"), /port/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
