import type { z } from "zod";
import type { ConfigSchema, ServerConfigSchema } from "./config.js";

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const VERSION = "0.3.0";

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
  /** Tool title, if the upstream server declares one */
  title?: string;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Listed directly in `tools/list` (config `always`) */
  always: boolean;
}

export interface CallToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}
