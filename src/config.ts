import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const StdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
});

const SseServerSchema = z.object({
  url: z.string().url(),
  transport: z.literal("sse"),
  headers: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
});

const StreamableHttpServerSchema = z.object({
  url: z.string().url(),
  transport: z.literal("streamable-http").optional(),
  headers: z.record(z.string()).optional(),
  prefix: z.union([z.boolean(), z.string()]).optional(),
});

export const ServerConfigSchema = z.discriminatedUnion("transport", [
  SseServerSchema,
  StreamableHttpServerSchema.required({ transport: true }),
]).or(StdioServerSchema);

const ServerNameSchema = z.string().regex(
  /^[a-zA-Z0-9](?:[-a-zA-Z0-9]*[a-zA-Z0-9])?$/,
  "Server names must be alphanumeric with optional hyphens (no underscores, no leading/trailing hyphens)",
);

export const ConfigSchema = z.object({
  servers: z.record(ServerNameSchema, ServerConfigSchema),
});

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

  return result.data;
}
