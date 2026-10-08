import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { META_TOOL_NAMES, type Hub } from "./hub.js";
import { VERSION, type CallToolResult } from "./types.js";

const LIST_TOOLS = {
  name: "list_tools",
  description:
    "List available tools across all connected MCP servers. Use a prefix to filter by server name (e.g. \"weather\" returns all weather__* tools).",
  inputSchema: {
    type: "object" as const,
    properties: {
      prefix: { type: "string", description: "Filter tools by prefix (typically a server name)" },
    },
  },
};

const CALL_TOOL = {
  name: "call_tool",
  description:
    "Call a tool by its fully qualified name (e.g. \"weather__get_forecast\"). Use list_tools first to discover available tools and their schemas.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Fully qualified tool name (server__tool)" },
      arguments: { type: "object", description: "Arguments to pass to the tool" },
    },
    required: ["name"],
  },
};

const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function listToolsResult(hub: Hub, args: Record<string, unknown>): CallToolResult {
  const { prefix } = args;
  if (prefix !== undefined && typeof prefix !== "string") return fail('Invalid arguments: "prefix" must be a string.');

  const tools = hub.listTools(prefix);
  if (tools.length === 0) {
    return {
      content: [{
        type: "text",
        text: prefix
          ? `No tools found matching prefix "${prefix}". Call list_tools without a prefix to see all available tools.`
          : "No tools available. Check that servers are configured and running.",
      }],
    };
  }

  const summary = tools.map((t) => ({
    name: t.qualifiedName,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
}

/**
 * Build the MCP server fronting a hub. Every tool call is logged to stderr with
 * the calling client (from the transport's auth info), the tool and the outcome.
 */
export function createMcpServer(hub: Hub): Server {
  const server = new Server({ name: "mcp-meta-hub", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      LIST_TOOLS,
      CALL_TOOL,
      ...hub.directTools().map((t) => ({
        name: t.qualifiedName,
        ...(t.title !== undefined && { title: t.title }),
        description: t.description,
        inputSchema: t.inputSchema as { type: "object" },
        ...(t.outputSchema && { outputSchema: t.outputSchema as { type: "object" } }),
        ...(t.annotations && { annotations: t.annotations }),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const started = Date.now();
    let target = name;
    let result: CallToolResult;

    if (name === "list_tools") {
      result = listToolsResult(hub, args);
    } else if (name === "call_tool") {
      const { name: innerName, arguments: innerArgs } = args;
      if (typeof innerName !== "string" || innerName === "") {
        result = fail('Invalid arguments: "name" is required and must be a string.');
      } else if (innerArgs !== undefined && !isRecord(innerArgs)) {
        result = fail('Invalid arguments: "arguments" must be an object.');
      } else if (META_TOOL_NAMES.includes(innerName)) {
        result = fail(`"${innerName}" is a meta-tool, call it directly.`);
      } else {
        target = innerName;
        result = await hub.callTool(innerName, innerArgs ?? {});
      }
    } else if (hub.directTools().some((t) => t.qualifiedName === name)) {
      result = await hub.callTool(name, args);
    } else {
      result = fail(`Unknown tool: "${name}". Use list_tools to discover available tools.`);
    }

    const client = extra.authInfo?.clientId ?? "stdio";
    console.error(
      `[mcp-meta-hub] call client=${client} tool=${JSON.stringify(target)} result=${result.isError ? "error" : "ok"} duration=${Date.now() - started}ms`,
    );
    return result as never;
  });

  return server;
}
