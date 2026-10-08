import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { createMcpServer } from "./meta-tools.js";
import { parseHttpAddress, resolveClientTokens, startHttp } from "./http.js";

const SHUTDOWN_TIMEOUT_MS = 5000;

const USAGE = "Usage: mcp-meta-hub [config] [--http <host:port>]";

function parseArgs(argv: string[]): { configPath: string; http?: string } {
  let configPath: string | undefined;
  let http: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") {
      http = argv[++i];
      if (!http) throw new Error(`--http needs a value. ${USAGE}`);
    } else if (arg.startsWith("--http=")) {
      http = arg.slice("--http=".length);
    } else if (arg.startsWith("-") || configPath !== undefined) {
      throw new Error(`Unexpected argument "${arg}". ${USAGE}`);
    } else {
      configPath = arg;
    }
  }
  return { configPath: configPath ?? "mcp-hub.json", http };
}

async function main(): Promise<void> {
  let args, config, address, tokens;
  try {
    args = parseArgs(process.argv.slice(2));
    config = await loadConfig(args.configPath);
    if (args.http !== undefined) {
      address = parseHttpAddress(args.http);
      tokens = resolveClientTokens(config.clients);
    }
  } catch (error) {
    console.error(`[mcp-meta-hub] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const hub = new Hub();
  await hub.start(config);

  let httpServer: HttpServer | undefined;
  if (address && tokens) {
    httpServer = await startHttp(hub, address, tokens);
    console.error(`[mcp-meta-hub] Listening on http://${address.host}:${address.port}/mcp`);
  } else {
    await createMcpServer(hub).connect(new StdioServerTransport());
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    if (httpServer) {
      const closed = new Promise((resolve) => httpServer.close(resolve));
      httpServer.closeAllConnections();
      await closed;
    }
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // In stdio mode a parent that dies without signalling (e.g. npm exec killed)
  // closes stdin: shut down then. Never in HTTP mode, where stdin may be /dev/null.
  if (!httpServer) process.stdin.on("close", () => void shutdown());
}

main().catch((error) => {
  console.error(`[mcp-meta-hub] Fatal: ${error}`);
  process.exit(1);
});
