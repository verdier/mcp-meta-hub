/**
 * In-process lifecycle test: every request gets its own MCP server and
 * transport, and both are closed whether the request succeeds, fails or is aborted.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { request, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { strict as assert } from "node:assert";
import { Hub } from "./hub.js";
import { startHttp } from "./http.js";
import { createRunner } from "./test-runner.js";

const TOKEN = "lifecycle-token";

async function run() {
  const { test, finish } = createRunner();

  // Spy on the SDK classes: record every transport that gets connected and every one that gets closed.
  const connected: unknown[] = [];
  const closedTransports = new Set<unknown>();
  const closedServers = new Set<unknown>();
  const origConnect = Server.prototype.connect;
  const origTClose = StreamableHTTPServerTransport.prototype.close;
  const origSClose = Server.prototype.close;
  Server.prototype.connect = function (this: Server, t: never) {
    connected.push(t);
    return origConnect.call(this, t);
  };
  StreamableHTTPServerTransport.prototype.close = function (this: StreamableHTTPServerTransport) {
    closedTransports.add(this);
    return origTClose.call(this);
  };
  Server.prototype.close = function (this: Server) {
    closedServers.add(this);
    return origSClose.call(this);
  };

  const hub = new Hub();
  await hub.start({ servers: { weather: { command: "node", args: ["examples/weather/dist/index.js"] } } });
  let delayMs = 0;
  const realCall = hub.callTool.bind(hub);
  hub.callTool = async (name, args) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return realCall(name, args);
  };
  const httpServer: HttpServer = await startHttp(hub, { host: "127.0.0.1", port: 0 }, new Map([["c", TOKEN]]));
  const port = (httpServer.address() as AddressInfo).port;

  const settle = () => new Promise((r) => setTimeout(r, 200));
  const connect = async () => {
    const client = new Client({ name: "lifecycle", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
    return client;
  };
  const assertAllClosed = (minimum: number) => {
    assert.ok(connected.length >= minimum, `expected at least ${minimum} requests, saw ${connected.length}`);
    for (const t of connected) assert.ok(closedTransports.has(t), "a transport was left open");
  };

  console.log("lifecycle tests\n");

  try {
    await test("a fresh transport per request, all closed after normal calls", async () => {
      const client = await connect();
      await client.callTool({ name: "call_tool", arguments: { name: "weather__list_cities" } });
      await client.callTool({ name: "call_tool", arguments: { name: "weather__list_cities" } });
      await client.close();
      await settle();
      assert.ok(connected.length >= 4);
      assert.strictEqual(new Set(connected).size, connected.length, "a transport was reused across requests");
      assertAllClosed(4);
      assert.strictEqual(closedServers.size, closedTransports.size);
    });

    await test("transports are closed after a tool error", async () => {
      const before = connected.length;
      const client = await connect();
      const r = await client.callTool({ name: "call_tool", arguments: { name: "weather__get_forecast", arguments: { city: "atlantis" } } });
      assert.ok(r.isError);
      await client.close();
      await settle();
      assertAllClosed(before + 2);
    });

    await test("transports are closed when the client aborts mid-request", async () => {
      const before = connected.length;
      await new Promise<void>((resolve) => {
        const req = request({
          host: "127.0.0.1", port, path: "/mcp", method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${TOKEN}`,
          },
        });
        req.on("error", () => {});
        const body = {
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "call_tool", arguments: { name: "weather__list_cities" } },
        };
        delayMs = 600;
        req.end(JSON.stringify(body));
        req.once("socket", (s) => setTimeout(() => { s.destroy(); resolve(); }, 150));
      });
      assert.strictEqual(connected.length, before + 1, "the aborted request never reached the handler");
      await new Promise((r) => setTimeout(r, 900));
      delayMs = 0;
      assertAllClosed(before + 1);
    });
  } finally {
    httpServer.closeAllConnections();
    httpServer.close();
    await hub.stop();
    Server.prototype.connect = origConnect;
    StreamableHTTPServerTransport.prototype.close = origTClose;
    Server.prototype.close = origSClose;
  }

  finish();
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
