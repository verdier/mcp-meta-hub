import type { Config, CatalogEntry, CallToolResult } from "./types.js";
import { connectServer, type ConnectedServer } from "./transports.js";

export class Hub {
  private servers: ConnectedServer[] = [];
  private catalog: Map<string, CatalogEntry> = new Map();
  private serverByTool: Map<string, ConnectedServer> = new Map();

  async start(config: Config): Promise<void> {
    const entries = Object.entries(config.servers);
    const results = await Promise.allSettled(
      entries.map(([name, serverConfig]) => connectServer(name, serverConfig)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const serverName = entries[i][0];
      const serverConfig = entries[i][1];
      if (result.status === "rejected") {
        console.error(`[mcp-meta-hub] Failed to connect to "${serverName}": ${result.reason}`);
        continue;
      }
      const server = result.value;
      this.servers.push(server);
      try {
        const prefixFn = this.buildPrefixFn(serverName, serverConfig.prefix);
        await this.discoverTools(server, prefixFn);
      } catch (err) {
        console.error(`[mcp-meta-hub] Failed to discover tools for "${serverName}": ${err}`);
      }
    }

    console.error(`[mcp-meta-hub] Ready — ${this.catalog.size} tools from ${this.servers.length} server(s)`);
  }

  private buildPrefixFn(serverName: string, prefix?: boolean | string): (toolName: string) => string {
    if (prefix === false) return (t) => t;
    if (typeof prefix === "string") return (t) => `${prefix}${t}`;
    // default (true/undefined): server__tool
    return (t) => `${serverName}__${t}`;
  }

  private async discoverTools(server: ConnectedServer, prefixFn: (toolName: string) => string): Promise<void> {
    const { tools } = await server.client.listTools();
    for (const tool of tools) {
      const qualifiedName = prefixFn(tool.name);
      this.catalog.set(qualifiedName, {
        qualifiedName,
        originalName: tool.name,
        serverName: server.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      });
      this.serverByTool.set(qualifiedName, server);
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

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.catalog.get(name);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Unknown tool: "${name}". Use list_tools to discover available tools.` }],
        isError: true,
      };
    }

    const server = this.serverByTool.get(name);
    if (!server) {
      return {
        content: [{ type: "text", text: `Server for tool "${name}" is not connected.` }],
        isError: true,
      };
    }

    const result = await server.client.callTool({
      name: entry.originalName,
      arguments: args,
    });

    return result as CallToolResult;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.cleanup()));
    this.servers = [];
    this.catalog.clear();
    this.serverByTool.clear();
  }
}
