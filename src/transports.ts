import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "./types.js";

export interface ConnectedServer {
  name: string;
  client: Client;
  cleanup: () => Promise<void>;
}

function isStdioConfig(config: ServerConfig): config is { command: string; args: string[]; env?: Record<string, string> } {
  return "command" in config;
}

function isSseConfig(config: ServerConfig): config is { url: string; transport: "sse"; headers?: Record<string, string> } {
  return "url" in config && "transport" in config && (config as { transport?: string }).transport === "sse";
}

/**
 * Resolve $VAR references in env values from process.env.
 * e.g. { "DB_PASS": "$MY_SECRET" } → { "DB_PASS": "actual-value" }
 */
export function resolveEnvRefs(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith("$") && value.length > 1) {
      const envKey = value.slice(1);
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        resolved[key] = envValue;
      } else {
        console.error(`[mcp-meta-hub] Warning: env var "${envKey}" not found for "${key}", keeping literal "${value}"`);
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function connectServer(name: string, config: ServerConfig): Promise<ConnectedServer> {
  const client = new Client({ name: `mcp-meta-hub/${name}`, version: "0.1.7" });

  if (isStdioConfig(config)) {
    const env = config.env ? resolveEnvRefs(config.env) : {};
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...env } as Record<string, string>,
    });
    await client.connect(transport);
    return {
      name,
      client,
      cleanup: async () => { await client.close(); },
    };
  }

  if (isSseConfig(config)) {
    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    await client.connect(transport);
    return {
      name,
      client,
      cleanup: async () => { await client.close(); },
    };
  }

  // Streamable HTTP (default for url-based configs)
  const urlConfig = config as { url: string; headers?: Record<string, string> };
  const transport = new StreamableHTTPClientTransport(new URL(urlConfig.url), {
    requestInit: urlConfig.headers ? { headers: urlConfig.headers } : undefined,
  });
  await client.connect(transport);
  return {
    name,
    client,
    cleanup: async () => { await client.close(); },
  };
}
