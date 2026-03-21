/**
 * Resilience tests: hub starts and works even with broken servers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";
import { strict as assert } from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

type TextContent = { type: string; text: string };

async function run() {
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

  console.log("resilience tests\n");

  // Write a config with one broken server and one working server
  const configPath = resolve(projectRoot, "mcp-hub.test-resilience.json");
  await writeFile(configPath, JSON.stringify({
    servers: {
      broken: {
        command: "node",
        args: ["-e", "process.exit(1)"],
      },
      weather: {
        command: "node",
        args: ["examples/weather/dist/index.js"],
      },
    },
  }));

  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [resolve(projectRoot, "dist/index.js"), configPath],
      cwd: projectRoot,
    });
    const client = new Client({ name: "test-resilience", version: "1.0.0" });
    await client.connect(transport);

    await test("hub starts despite broken server", async () => {
      const { tools } = await client.listTools();
      assert.strictEqual(tools.length, 2); // list_tools + call_tool
    });

    await test("working server tools are still available", async () => {
      const result = await client.callTool({ name: "list_tools", arguments: { prefix: "weather" } });
      const content = result.content as TextContent[];
      const tools = JSON.parse(content[0].text);
      assert.ok(tools.length >= 2);
      assert.ok(tools.some((t: { name: string }) => t.name === "weather__get_forecast"));
    });

    await test("broken server tools are absent (not crashing)", async () => {
      const result = await client.callTool({ name: "list_tools", arguments: { prefix: "broken" } });
      const content = result.content as TextContent[];
      assert.ok(content[0].text.includes("No tools found"));
    });

    await client.close();
  } finally {
    await unlink(configPath).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
