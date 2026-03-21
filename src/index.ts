import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { createMcpServer } from "./meta-tools.js";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "mcp-hub.json";

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    console.error(`[mcp-meta-hub] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const hub = new Hub();
  await hub.start(config);

  const server = createMcpServer(hub);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[mcp-meta-hub] Fatal: ${error}`);
  process.exit(1);
});
