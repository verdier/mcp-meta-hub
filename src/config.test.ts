/**
 * Unit tests for config validation.
 */
import { strict as assert } from "node:assert";
import { ConfigSchema } from "./config.js";

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
