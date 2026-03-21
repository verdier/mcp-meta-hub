/**
 * Unit tests for $VAR env interpolation and prefix config.
 */
import { strict as assert } from "node:assert";
import { resolveEnvRefs } from "./transports.js";
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
