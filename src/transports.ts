import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VERSION, type ServerConfig } from "./types.js";

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
export function resolveEnvRefs(
  env: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith("$") && value.length > 1) {
      const envKey = value.slice(1);
      const envValue = source[envKey];
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

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Environment for a stdio child: the hub's own environment minus every variable
 * whose name looks like a secret, then the declared `env` (its `$VAR` references
 * are resolved against the full, unscrubbed hub environment).
 */
export function childEnv(
  declared: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SECRET_NAME.test(key)) env[key] = value;
  }
  return { ...env, ...(declared ? resolveEnvRefs(declared, base) : {}) };
}

/** `fetch` replaces the HTTP stack of a streamable-http child (OAuth children). */
export async function connectServer(name: string, config: ServerConfig, fetch?: FetchLike): Promise<ConnectedServer> {
  const client = new Client({ name: `mcp-meta-hub/${name}`, version: VERSION });

  if (isStdioConfig(config)) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: childEnv(config.env),
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
    fetch,
  });
  await client.connect(transport);
  return {
    name,
    client,
    cleanup: async () => { await client.close(); },
  };
}
