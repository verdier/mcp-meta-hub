import type { z } from "zod";
import type { ConfigSchema, ServerConfigSchema } from "./config.js";

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface CatalogEntry {
  /** Fully qualified name: `{serverName}__{toolName}` */
  qualifiedName: string;
  /** Original tool name on the upstream server */
  originalName: string;
  /** Server this tool belongs to */
  serverName: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}
