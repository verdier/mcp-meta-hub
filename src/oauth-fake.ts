/**
 * Test support: a local OAuth authorization server and protected MCP server on
 * one origin. Dynamic registration, authorization with exact redirect URI and
 * real S256 PKCE, code and refresh grants (rotation optional), and switchable
 * failures. Never part of the published build.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface FakeBehaviour {
  rotate: boolean;
  /** Refresh responses carry no refresh_token. */
  omitRefreshToken: boolean;
  refreshFailure?: "invalid_grant" | "invalid_client" | "server_error" | "down";
  /** The MCP endpoint answers 401 whatever the token. */
  always401: boolean;
  tokenDelayMs: number;
  tools: string[];
  /** Published as authorization_endpoint instead of the real one. */
  authorizationEndpoint?: string;
  /** Refresh responses carry the access token the server issued first, re-validated. */
  reuseAccessToken?: boolean;
  /** The code grant answers after this long. */
  codeDelayMs?: number;
  /** The token endpoint answers 400 with this (non-JSON) body. */
  tokenRawBody?: string;
  /** Authorization server metadata answers after this long. */
  metadataDelayMs?: number;
  /** `tools/call` of these tools answers 401 whatever the token. */
  unauthorizedTools?: string[];
  /** `tools/call` of these tools needs a token holding scope "special" (else 403 insufficient_scope). */
  scopeGatedTools?: string[];
  /** Refresh grants issue tokens holding scope "special". */
  refreshGrantsSpecial?: boolean;
  /** The protected-resource metadata lives only at the URL the 401 challenge names, plus its scope. */
  challengeOnlyMetadata?: boolean;
  challengeScope?: string;
  /** Protected-resource metadata answers after this long. */
  prmDelayMs?: number;
  /** `tools/call` of `echo` fails with this JSON-RPC error message. */
  echoErrorMessage?: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const random = () => b64url(randomBytes(24));

export class FakeOAuthServer {
  origin = "";
  behaviour: FakeBehaviour = { rotate: true, omitRefreshToken: false, always401: false, tokenDelayMs: 0, tools: ["echo", "slow", "list_cities"] };
  readonly counts = { register: 0, authorize: 0, codeGrant: 0, refreshGrant: 0, mcp: 0, mcpGet: 0, challengeMetadata: 0, wellKnownMetadata: 0 };
  readonly clients = new Map<string, { redirect_uris: string[] }>();
  readonly authorizeRequests: URLSearchParams[] = [];
  private codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  private access = new Set<string>();
  private refresh = new Map<string, string>();
  private special = new Set<string>();
  private fixedAccess?: string;
  /** Which grant issued an access token. */
  readonly issuedBy = new Map<string, "code" | "refresh">();
  private http?: HttpServer;

  async start(): Promise<void> {
    this.http = createServer((req, res) => void this.handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }));
    await new Promise<void>((r) => this.http!.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.http!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections();
    await new Promise((r) => this.http?.close(r));
  }

  /** Invalidate every access token: the next MCP request gets a 401. */
  expireAccessTokens(): void {
    this.access.clear();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<string> {
    let data = "";
    for await (const chunk of req) data += chunk;
    return data;
  }

  private issueTokens(clientId: string, grant: "code" | "refresh", refreshToken = true): Record<string, unknown> {
    const reuse = grant === "refresh" && this.behaviour.reuseAccessToken;
    const access = reuse ? (this.fixedAccess ??= random()) : random();
    this.access.add(access);
    this.issuedBy.set(access, grant);
    if (grant === "refresh" && this.behaviour.refreshGrantsSpecial) this.special.add(access);
    const tokens: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 3600 };
    if (refreshToken) {
      const rt = random();
      this.refresh.set(rt, clientId);
      tokens.refresh_token = rt;
    }
    return tokens;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.origin);
    const path = url.pathname;

    if (path === "/resource-info") {
      this.counts.challengeMetadata++;
      return this.json(res, 200, { resource: `${this.origin}/mcp`, authorization_servers: [this.origin] });
    }
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      this.counts.wellKnownMetadata++;
      await new Promise((r) => setTimeout(r, this.behaviour.prmDelayMs ?? 0));
      if (this.behaviour.challengeOnlyMetadata) return this.json(res, 404, {});
      return this.json(res, 200, { resource: `${this.origin}/mcp`, authorization_servers: [this.origin] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      await new Promise((r) => setTimeout(r, this.behaviour.metadataDelayMs ?? 0));
      return this.json(res, 200, {
        issuer: this.origin,
        authorization_endpoint: this.behaviour.authorizationEndpoint ?? `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (path === "/register" && req.method === "POST") {
      this.counts.register++;
      const metadata = JSON.parse(await this.body(req));
      const clientId = random();
      this.clients.set(clientId, { redirect_uris: metadata.redirect_uris });
      return this.json(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (path === "/authorize" && req.method === "GET") {
      this.counts.authorize++;
      const q = url.searchParams;
      this.authorizeRequests.push(q);
      const client = this.clients.get(q.get("client_id") ?? "");
      const redirectUri = q.get("redirect_uri") ?? "";
      if (!client || !client.redirect_uris.includes(redirectUri) || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")) {
        return this.json(res, 400, { error: "invalid_request" });
      }
      const code = random();
      this.codes.set(code, { clientId: q.get("client_id")!, redirectUri, challenge: q.get("code_challenge")! });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await this.body(req));
      if (form.get("grant_type") === "authorization_code") {
        this.counts.codeGrant++;
        await new Promise((r) => setTimeout(r, this.behaviour.codeDelayMs ?? 0));
        if (this.behaviour.tokenRawBody !== undefined) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(this.behaviour.tokenRawBody);
          return;
        }
        const code = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!code || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri")
          || b64url(createHash("sha256").update(verifier).digest()) !== code.challenge) {
          return this.json(res, 400, { error: "invalid_grant" });
        }
        return this.json(res, 200, this.issueTokens(code.clientId, "code"));
      }
      if (form.get("grant_type") === "refresh_token") {
        this.counts.refreshGrant++;
        await new Promise((r) => setTimeout(r, this.behaviour.tokenDelayMs));
        const failure = this.behaviour.refreshFailure;
        if (failure === "down") {
          req.socket.destroy();
          return;
        }
        if (failure === "server_error") {
          res.writeHead(503).end("unavailable");
          return;
        }
        if (this.behaviour.tokenRawBody !== undefined) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(this.behaviour.tokenRawBody);
          return;
        }
        if (failure) return this.json(res, failure === "invalid_client" ? 401 : 400, { error: failure });
        const rt = form.get("refresh_token") ?? "";
        const clientId = this.refresh.get(rt);
        if (!clientId || clientId !== form.get("client_id")) return this.json(res, 400, { error: "invalid_grant" });
        if (this.behaviour.omitRefreshToken) return this.json(res, 200, this.issueTokens(clientId, "refresh", false));
        if (this.behaviour.rotate) this.refresh.delete(rt);
        return this.json(res, 200, this.issueTokens(clientId, "refresh"));
      }
      return this.json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/mcp") {
      this.counts.mcp++;
      if (req.method === "GET") this.counts.mcpGet++;
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const body = req.method === "POST" ? JSON.parse(await this.body(req) || "null") : undefined;
      const tool = body?.method === "tools/call" ? (body.params?.name as string) : undefined;
      const challenge = `resource_metadata="${this.origin}${this.behaviour.challengeOnlyMetadata ? "/resource-info" : "/.well-known/oauth-protected-resource/mcp"}"`;
      if (this.behaviour.always401 || !token || !this.access.has(token) || (tool && this.behaviour.unauthorizedTools?.includes(tool))) {
        const scope = this.behaviour.challengeScope ? `, scope="${this.behaviour.challengeScope}"` : "";
        res.writeHead(401, { "WWW-Authenticate": `Bearer ${challenge}${scope}` }).end();
        return;
      }
      if (tool && this.behaviour.scopeGatedTools?.includes(tool) && !this.special.has(token)) {
        res.writeHead(403, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="special", ${challenge}` }).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      const server = this.mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  }

  private mcpServer(): Server {
    const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
    const tools = this.behaviour.tools;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object" as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "echo" && this.behaviour.echoErrorMessage) throw new McpError(ErrorCode.InternalError, this.behaviour.echoErrorMessage);
      if (request.params.name === "slow") await new Promise((r) => setTimeout(r, 500));
      return { content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, args: request.params.arguments ?? {} }) }] };
    });
    return server;
  }
}
