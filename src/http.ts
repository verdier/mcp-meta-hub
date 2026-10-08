import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config } from "./types.js";
import type { Hub } from "./hub.js";
import { createMcpServer } from "./meta-tools.js";

type Req = IncomingMessage & { body?: unknown; auth?: AuthInfo };
type Res = ServerResponse & { status(code: number): Res; json(body: unknown): Res; set(name: string, value: string): Res };

// Exactly the hosts the SDK protects against DNS rebinding (case-sensitive).
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpAddress {
  host: string;
  port: number;
}

/** Parse `host:port` (IPv6 as `[::1]:port`); the host must be a loopback address. */
export function parseHttpAddress(value: string): HttpAddress {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) throw new Error(`Invalid --http value "${value}": expected <host:port>`);
  const host = value.slice(0, idx).replace(/^\[(.*)\]$/, "$1");
  const portText = value.slice(idx + 1);
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new Error(`Invalid --http value "${value}": bad port`);
  }
  if (!LOOPBACK.has(host)) {
    throw new Error(`Refusing to listen on ${JSON.stringify(host)}: only loopback addresses are allowed`);
  }
  return { host, port };
}

/**
 * Resolve each client's bearer token from the environment. Throws if there are
 * no clients, or if a token is missing, empty or shared by two clients.
 */
export function resolveClientTokens(
  clients: Config["clients"],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  if (!clients || Object.keys(clients).length === 0) {
    throw new Error('HTTP mode requires a non-empty "clients" object in the config');
  }
  const tokens = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const [client, { tokenEnv }] of Object.entries(clients)) {
    const token = env[tokenEnv];
    if (!token) throw new Error(`Client "${client}": environment variable ${tokenEnv} is missing or empty`);
    const other = owners.get(token);
    if (other) throw new Error(`Clients "${other}" and "${client}" share the same token`);
    owners.set(token, client);
    tokens.set(client, token);
  }
  return tokens;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

const jsonRpcError = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

/** Bearer gate: true if the token matches a client (sets `req.auth`), else answers 401. */
export function authenticate(tokens: Map<string, string>) {
  const digests = Array.from(tokens, ([client, token]) => ({ client, digest: digest(token) }));
  return (req: Req, res: ServerResponse): boolean => {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    if (match) {
      const given = digest(match[1]);
      let found: string | undefined;
      for (const c of digests) {
        if (timingSafeEqual(given, c.digest)) found = c.client;
      }
      if (found) {
        req.auth = { token: "", clientId: found, scopes: [] };
        return true;
      }
    }
    jsonRpcError(res, 401, -32001, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    return false;
  };
}

const methodNotAllowed = (_req: Req, res: Res) => {
  res.set("Allow", "POST").status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

/**
 * Serve the hub over stateless Streamable HTTP on `/mcp`: no session, a fresh
 * MCP server and transport per request.
 */
export function startHttp(hub: Hub, addr: HttpAddress, tokens: Map<string, string>): Promise<HttpServer> {
  const app = createMcpExpressApp({ host: addr.host });
  app.disable("x-powered-by");
  const route = "/mcp";

  app.post(route, (async (req: Req, res: Res) => {
    const server = createMcpServer(hub);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp-meta-hub] Request failed: ${err}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  }) as never);

  app.get(route, methodNotAllowed as never);
  app.delete(route, methodNotAllowed as never);

  // Body-parser failures (malformed JSON) become JSON-RPC errors, never an HTML page.
  app.use(((err: { status?: number }, _req: Req, res: Res, _next: unknown) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    jsonRpcError(res, status, status === 500 ? -32603 : -32700, status === 500 ? "Internal server error" : "Parse error");
  }) as never);

  // The bearer gate wraps the whole app: nothing, not even body parsing, runs before it.
  const gate = authenticate(tokens);
  const httpServer = createServer((req, res) => {
    if (gate(req, res)) (app as unknown as (q: IncomingMessage, r: ServerResponse) => void)(req, res);
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(addr.port, addr.host, () => {
      httpServer.off("error", reject);
      resolve(httpServer);
    });
  });
}
