import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, CatalogEntry, CallToolResult, ServerConfig } from "./types.js";
import { connectServer, type ConnectedServer } from "./transports.js";

/** Names taken by the hub's own meta-tools. */
export const META_TOOL_NAMES = ["list_tools", "call_tool"];

const log = (msg: string) => console.error(`[mcp-meta-hub] ${msg}`);

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export class Hub {
  private servers: Map<string, ConnectedServer> = new Map();
  private catalog: Map<string, CatalogEntry> = new Map();

  async start(config: Config): Promise<void> {
    const entries = Object.entries(config.servers);
    const results = await Promise.allSettled(
      entries.map(([name, serverConfig]) => connectServer(name, serverConfig)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const [serverName, serverConfig] = entries[i];
      if (result.status === "rejected") {
        log(`Failed to connect to "${serverName}": ${result.reason}`);
        continue;
      }
      const server = result.value;
      this.servers.set(serverName, server);
      try {
        const { tools } = await server.client.listTools();
        this.addTools(serverName, serverConfig, tools);
      } catch (err) {
        log(`Failed to discover tools for "${serverName}": ${err}`);
      }
    }

    log(`Ready — ${this.catalog.size} tools from ${this.servers.size} server(s)`);
  }

  private buildPrefixFn(serverName: string, prefix?: boolean | string): (toolName: string) => string {
    if (prefix === false) return (t) => t;
    if (typeof prefix === "string") return (t) => `${prefix}${t}`;
    // default (true/undefined): server__tool
    return (t) => `${serverName}__${t}`;
  }

  /**
   * Register a server's tools in the catalog. A tool whose effective name is
   * already taken (by another tool or a meta-tool) is skipped, never overwritten.
   */
  addTools(serverName: string, config: Pick<ServerConfig, "prefix" | "always">, tools: Tool[]): void {
    const prefixFn = this.buildPrefixFn(serverName, config.prefix);
    const always = config.always;

    if (Array.isArray(always)) {
      const known = new Set(tools.map((t) => t.name));
      for (const name of always) {
        if (!known.has(name)) log(`Warning: "always" lists unknown tool "${name}" on "${serverName}"`);
      }
    }

    for (const tool of tools) {
      const qualifiedName = prefixFn(tool.name);
      if (META_TOOL_NAMES.includes(qualifiedName) || this.catalog.has(qualifiedName)) {
        log(`Error: tool "${qualifiedName}" from "${serverName}" collides with an existing name, skipped`);
        continue;
      }

      let isAlways = always === true || (Array.isArray(always) && always.includes(tool.name));
      if (isAlways && tool.inputSchema?.type !== "object") {
        log(`Warning: "${qualifiedName}" has no object inputSchema, not listed directly`);
        isAlways = false;
      }

      this.catalog.set(qualifiedName, {
        qualifiedName,
        originalName: tool.name,
        serverName,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        title: tool.title,
        outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
        annotations: tool.annotations as Record<string, unknown> | undefined,
        always: isAlways,
      });
    }
  }

  listTools(prefix?: string): CatalogEntry[] {
    const entries = Array.from(this.catalog.values());
    if (!prefix) return entries;
    const normalized = prefix.toLowerCase();
    return entries.filter(
      (e) => e.qualifiedName.toLowerCase().startsWith(normalized),
    );
  }

  /** Tools listed directly in `tools/list` (config `always`). */
  directTools(): CatalogEntry[] {
    return Array.from(this.catalog.values()).filter((e) => e.always);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.catalog.get(name);
    if (!entry) {
      return errorResult(`Unknown tool: "${name}". Use list_tools to discover available tools.`);
    }

    const server = this.servers.get(entry.serverName);
    if (!server) {
      return errorResult(`Server for tool "${name}" is not connected.`);
    }

    try {
      const result = await server.client.callTool({
        name: entry.originalName,
        arguments: args,
      });
      return result as CallToolResult;
    } catch (err) {
      return errorResult(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(Array.from(this.servers.values()).map((s) => s.cleanup()));
    this.servers.clear();
    this.catalog.clear();
  }
}
