import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pureOrigin } from "./oauth/network.js";

/** `true` exposes every tool of the server directly; an array selects tools by original name. */
const AlwaysSchema = z.union([z.boolean(), z.array(z.string())]).optional();

const StdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
  always: AlwaysSchema,
});

const SseServerSchema = z.object({
  url: z.string().url(),
  transport: z.literal("sse"),
  headers: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
  always: AlwaysSchema,
});

/** `true` or options: the hub obtains and refreshes this child's OAuth grant itself. */
const ChildOAuthSchema = z.union([
  z.literal(true),
  z.object({
    scopes: z.array(z.string().min(1)).optional(),
    /** Pre-registered client; without it the hub registers dynamically. */
    clientId: z.string().min(1).optional(),
    clientName: z.string().min(1).optional(),
    /** Origins other than the endpoint's that OAuth traffic may reach (e.g. a separate authorization server). */
    allowedOrigins: z.array(z.string().refine((v) => pureOrigin(v) !== undefined, "must be an origin: http(s)://host[:port], no path, query, fragment or credentials")).optional(),
    /** Allow private and loopback addresses, and plain HTTP to them. Never implied. */
    allowPrivateNetwork: z.boolean().optional(),
  }).strict(),
]);

export type ChildOAuthOptions = Exclude<z.infer<typeof ChildOAuthSchema>, true>;

const StreamableHttpServerSchema = z.object({
  url: z.string().url(),
  transport: z.literal("streamable-http").optional(),
  headers: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
  always: AlwaysSchema,
  oauth: ChildOAuthSchema.optional(),
});

export const ServerConfigSchema = z.discriminatedUnion("transport", [
  SseServerSchema,
  StreamableHttpServerSchema.required({ transport: true }),
]).or(StdioServerSchema);

const ServerNameSchema = z.string().regex(
  /^[a-zA-Z0-9](?:[-a-zA-Z0-9]*[a-zA-Z0-9])?$/,
  "Server names must be alphanumeric with optional hyphens (no underscores, no leading/trailing hyphens)",
);

const ClientSchema = z.object({
  /** Name of the environment variable holding this client's bearer token. */
  tokenEnv: z.string().min(1),
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const OAuthSchema = z.object({
  /** Absolute URL of the callback, as the browser reaches the hub: `https://<host>/oauth/callback`. */
  redirectUrl: z.string().url().superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
      ctx.addIssue({ code: "custom", message: "must use https (http only on a loopback host)" });
    }
    if (url.pathname !== "/oauth/callback" || url.search || url.hash || url.username || url.password) {
      ctx.addIssue({ code: "custom", message: 'must be "<origin>/oauth/callback", without query, fragment or credentials' });
    }
  }),
  /** Directory of the credential store; relative paths resolve against the config file. Default "oauth". */
  storeDir: z.string().min(1).optional(),
}).strict();

export const ConfigSchema = z.preprocess((raw, ctx) => {
  // Union members strip unknown keys, so `oauth` on a stdio or SSE child would vanish silently.
  const servers = (raw as { servers?: unknown })?.servers;
  if (servers && typeof servers === "object") {
    for (const [name, server] of Object.entries(servers)) {
      const s = server as { oauth?: unknown; transport?: unknown } | null;
      if (s?.oauth !== undefined && s.transport !== "streamable-http") {
        ctx.addIssue({ code: "custom", path: ["servers", name, "oauth"], message: '"oauth" is only supported on streamable-http servers' });
      }
    }
  }
  return raw;
}, z.object({
  servers: z.record(ServerNameSchema, ServerConfigSchema),
  /** HTTP mode only: one bearer token per named client. */
  clients: z.record(z.string().min(1), ClientSchema).optional(),
  oauth: OAuthSchema.optional(),
}).superRefine((config, ctx) => {
  for (const [name, server] of Object.entries(config.servers)) {
    if ("oauth" in server && server.oauth && !config.oauth) {
      ctx.addIssue({ code: "custom", path: ["servers", name, "oauth"], message: 'needs a global "oauth.redirectUrl"' });
    }
  }
}));

export async function loadConfig(configPath: string): Promise<z.infer<typeof ConfigSchema>> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${absolutePath}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config in ${absolutePath}:\n${issues}`);
  }

  const config = result.data;
  if (config.oauth) config.oauth.storeDir = resolve(dirname(absolutePath), config.oauth.storeDir ?? "oauth");
  return config;
}
