import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hub } from "./hub.js";

export function createMcpServer(hub: Hub): McpServer {
  const server = new McpServer({
    name: "mcp-meta-hub",
    version: "0.1.11",
  });

  server.tool(
    "list_tools",
    "List available tools across all connected MCP servers. Use a prefix to filter by server name (e.g. \"weather\" returns all weather__* tools).",
    { prefix: z.string().optional().describe("Filter tools by prefix (typically a server name)") },
    async ({ prefix }) => {
      const tools = hub.listTools(prefix);
      if (tools.length === 0) {
        const msg = prefix
          ? `No tools found matching prefix "${prefix}". Call list_tools without a prefix to see all available tools.`
          : "No tools available. Check that servers are configured and running.";
        return { content: [{ type: "text" as const, text: msg }] };
      }

      const summary = tools.map((t) => ({
        name: t.qualifiedName,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );

  server.tool(
    "call_tool",
    "Call a tool by its fully qualified name (e.g. \"weather__get_forecast\"). Use list_tools first to discover available tools and their schemas.",
    {
      name: z.string().describe("Fully qualified tool name (server__tool)"),
      arguments: z.record(z.unknown()).optional().default({}).describe("Arguments to pass to the tool"),
    },
    async ({ name, arguments: args }) => {
      const result = await hub.callTool(name, args);
      return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
    },
  );

  return server;
}
