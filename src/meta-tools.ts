import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { META_TOOL_NAMES, toolError, unknownTool, type Hub } from "./hub.js";
import { VERSION, type CallToolResult } from "./types.js";

const ListToolsArgs = z.object({
  prefix: z.string().optional().describe("Filter tools by prefix (typically a server name)"),
});

const CallToolArgs = z.object({
  name: z.string().min(1).describe("Fully qualified tool name (server__tool)"),
  arguments: z.record(z.unknown()).optional().describe("Arguments to pass to the tool"),
});

const schemaOf = (schema: z.AnyZodObject) =>
  toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: "input" }) as { type: "object" };

const META_TOOLS = [
  {
    name: "list_tools",
    description:
      "List available tools across all connected MCP servers. Use a prefix to filter by server name (e.g. \"weather\" returns all weather__* tools).",
    inputSchema: schemaOf(ListToolsArgs),
  },
  {
    name: "call_tool",
    description:
      "Call a tool by its fully qualified name (e.g. \"weather__get_forecast\"). Use list_tools first to discover available tools and their schemas.",
    inputSchema: schemaOf(CallToolArgs),
  },
];

const invalidArguments = (error: z.ZodError) =>
  toolError(`Invalid arguments: ${error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);

function listToolsResult(hub: Hub, prefix?: string): CallToolResult {
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
      ...META_TOOLS,
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
      const parsed = ListToolsArgs.safeParse(args);
      result = parsed.success ? listToolsResult(hub, parsed.data.prefix) : invalidArguments(parsed.error);
    } else if (name === "call_tool") {
      const parsed = CallToolArgs.safeParse(args);
      if (!parsed.success) {
        result = invalidArguments(parsed.error);
      } else if (META_TOOL_NAMES.includes(parsed.data.name)) {
        result = toolError(`"${parsed.data.name}" is a meta-tool, call it directly.`);
      } else {
        target = parsed.data.name;
        result = await hub.callTool(target, parsed.data.arguments ?? {});
      }
    } else if (hub.directTools().some((t) => t.qualifiedName === name)) {
      result = await hub.callTool(name, args);
    } else {
      result = unknownTool(name);
    }

    const client = extra.authInfo?.clientId ?? "stdio";
    console.error(
      `[mcp-meta-hub] call client=${client} tool=${JSON.stringify(target)} result=${result.isError ? "error" : "ok"} duration=${Date.now() - started}ms`,
    );
    return result as never;
  });

  return server;
}
