/**
 * End-to-end test: start mcp-meta-hub with the weather example skill,
 * call list_tools and call_tool via MCP protocol.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

type TextContent = { type: string; text: string };

async function run() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(projectRoot, "dist/index.js"), resolve(projectRoot, "mcp-hub.json")],
    cwd: projectRoot,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
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

  console.log("mcp-meta-hub e2e tests\n");

  await test("exposes exactly 2 meta-tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ["call_tool", "list_tools"]);
  });

  await test("list_tools without prefix returns all weather tools", async () => {
    const result = await client.callTool({ name: "list_tools", arguments: {} });
    const content = result.content as TextContent[];
    const tools = JSON.parse(content[0].text);
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 2);
    const names = tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("weather__get_forecast"));
    assert.ok(names.includes("weather__list_cities"));
  });

  await test("list_tools with prefix filters", async () => {
    const result = await client.callTool({ name: "list_tools", arguments: { prefix: "weather" } });
    const content = result.content as TextContent[];
    const tools = JSON.parse(content[0].text);
    assert.ok(tools.every((t: { name: string }) => t.name.startsWith("weather__")));
  });

  await test("list_tools with unknown prefix returns helpful message", async () => {
    const result = await client.callTool({ name: "list_tools", arguments: { prefix: "nonexistent" } });
    const content = result.content as TextContent[];
    assert.ok(content[0].text.includes("No tools found"));
  });

  await test("call_tool routes to weather__list_cities", async () => {
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "weather__list_cities", arguments: {} },
    });
    const content = result.content as TextContent[];
    const cities = JSON.parse(content[0].text);
    assert.ok(Array.isArray(cities));
    assert.ok(cities.some((c: { name: string }) => c.name === "paris"));
  });

  await test("call_tool routes to weather__get_forecast", async () => {
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "weather__get_forecast", arguments: { city: "paris" } },
    });
    const content = result.content as TextContent[];
    const forecast = JSON.parse(content[0].text);
    assert.strictEqual(forecast.city, "paris");
    assert.strictEqual(forecast.country, "France");
    assert.ok(typeof forecast.temperature_celsius === "number");
  });

  await test("call_tool with unknown tool returns error", async () => {
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "unknown__tool", arguments: {} },
    });
    const content = result.content as TextContent[];
    assert.ok(content[0].text.includes("Unknown tool"));
  });

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
