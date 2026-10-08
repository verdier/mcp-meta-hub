// Fixture MCP child: reports its own environment and pid.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "env-child", version: "1.0.0" });
server.tool("env_report", "Report the child's environment and pid.", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify({ env: process.env, pid: process.pid }) }],
}));
await server.connect(new StdioServerTransport());
