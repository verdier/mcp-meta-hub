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

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // When the parent process dies without sending a signal (e.g. npm exec killed),
  // stdin receives EOF — use this as a reliable shutdown trigger.
  process.stdin.on("close", () => void shutdown());
}

main().catch((error) => {
  console.error(`[mcp-meta-hub] Fatal: ${error}`);
  process.exit(1);
});
