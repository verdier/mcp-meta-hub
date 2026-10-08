import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, CatalogEntry, CallToolResult, ServerConfig } from "./types.js";
import { resolve } from "node:path";
import { connectServer, type ConnectedServer } from "./transports.js";
import { AuthorizationBroker } from "./oauth/broker.js";
import { CALL_TIMEOUT_MS, CONNECT_TIMEOUT_MS, describeError, isAuthError, OAuthChild, type OAuthRuntime } from "./oauth/child.js";
import { CredentialStore } from "./oauth/store.js";

/** Names taken by the hub's own meta-tools. */
export const META_TOOL_NAMES = ["list_tools", "call_tool"];

const log = (msg: string) => console.error(`[mcp-meta-hub] ${msg}`);

export const toolError = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const unknownTool = (name: string): CallToolResult =>
  toolError(`Unknown tool: "${name}". Use list_tools to discover available tools.`);

export type ServerStatus = "connected" | "needs-auth" | "failed";

export interface ServerSummary {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  status: ServerStatus;
  tools: number;
  oauth: boolean;
}

interface Live {
  server: ConnectedServer;
  generation: number;
  inFlight: number;
  drained?: () => void;
}

interface Slot {
  config: ServerConfig;
  status: ServerStatus;
  /** Bumped by every connect: results and failures of an older generation are ignored. */
  generation: number;
  live?: Live;
  oauth?: OAuthChild;
  broken?: boolean;
}

const DRAIN_TIMEOUT_MS = 30_000;

export interface HubOptions {
  /** Bounds on an OAuth child's connect / authorization step and on a call to it (test seam). */
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export class Hub {
  private slots: Map<string, Slot> = new Map();
  private catalog: Map<string, CatalogEntry> = new Map();
  oauth?: OAuthRuntime;

  constructor(private readonly options: HubOptions = {}) {}

  async start(config: Config): Promise<void> {
    if (config.oauth) {
      const redirectUrl = new URL(config.oauth.redirectUrl);
      this.oauth = {
        broker: new AuthorizationBroker(),
        store: new CredentialStore(resolve(config.oauth.storeDir ?? "oauth")),
        redirectUrl,
        pageUrl: new URL("/", redirectUrl).toString(),
      };
    }
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const slot: Slot = { config: serverConfig, status: "failed", generation: 0 };
      if ("oauth" in serverConfig && serverConfig.oauth && this.oauth) {
        try {
          const child = new OAuthChild(name, serverConfig.url, serverConfig.oauth === true ? {} : serverConfig.oauth, this.oauth);
          await child.prepare();
          slot.oauth = child;
        } catch (err) {
          slot.broken = true;
          log(`OAuth setup of "${name}" failed: ${err instanceof Error ? err.message : "invalid options"}`);
        }
      }
      this.slots.set(name, slot);
    }

    // Install in config order, so collisions resolve the same way on every start.
    const installs = await Promise.all(Array.from(this.slots.keys(), (name) => this.connect(name)));
    for (const install of installs) install();

    const connected = Array.from(this.slots.values()).filter((s) => s.status === "connected").length;
    log(`Ready — ${this.catalog.size} tools from ${connected} server(s)`);
  }

  /**
   * Connect a new generation of `name`; resolve to the synchronous step that
   * installs the result, a no-op if a newer generation started meanwhile.
   */
  private connect(name: string): Promise<() => void> {
    const slot = this.slots.get(name)!;
    if (slot.broken) return Promise.resolve(() => undefined);
    const generation = ++slot.generation;
    if (!slot.oauth) return this.attempt(name, slot, generation);
    // An OAuth child connects inside its queue, bounded: a stuck authorization server must not hold the slot.
    return slot.oauth
      .run((signal) => this.attempt(name, slot, generation, signal), this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
      .catch((err) => this.failure(name, slot, generation, err));
  }

  private async attempt(name: string, slot: Slot, generation: number, signal?: AbortSignal): Promise<() => void> {
    try {
      const { server, tools } = await this.open(name, slot, signal);
      return () => {
        if (generation !== slot.generation) void server.cleanup().catch(() => undefined);
        else this.replaceServer(name, server, tools);
      };
    } catch (err) {
      return this.failure(name, slot, generation, err);
    }
  }

  private async open(name: string, slot: Slot, signal?: AbortSignal): Promise<{ server: ConnectedServer; tools: Tool[] }> {
    const oauth = slot.oauth && { authProvider: slot.oauth.provider, fetch: slot.oauth.fetch };
    const server = await connectServer(name, slot.config, oauth, signal);
    try {
      const tools = (await server.client.listTools(undefined, signal && { signal })).tools;
      signal?.throwIfAborted();
      return { server, tools };
    } catch (err) {
      await server.cleanup().catch(() => undefined);
      throw err;
    }
  }

  private failure(name: string, slot: Slot, generation: number, err: unknown): () => void {
    return () => {
      if (generation !== slot.generation) return;
      slot.status = slot.oauth && isAuthError(err) ? "needs-auth" : "failed";
      log(slot.status === "needs-auth"
        ? `"${name}" needs authorization: open ${this.oauth!.pageUrl}`
        : `Failed to connect to "${name}": ${slot.oauth ? describeError(err) : err}`);
    };
  }

  /** A fresh authorization of an OAuth child; resolves to the URL to send the browser to. */
  startAuthorization(name: string): Promise<string> {
    const slot = this.slots.get(name)!;
    const child = slot.oauth!;
    return child.run(
      (signal) => child.startAuthorization(async () => (await this.open(name, slot, signal)).server.cleanup()),
      this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
  }

  /**
   * The callback of an authorization, as one queue item: consume the flow, exchange
   * the code, reconnect. Resolves to the new status, undefined if the provider denied it.
   */
  async completeAuthorization(name: string, state: string, code: string | undefined): Promise<ServerStatus | undefined> {
    const slot = this.slots.get(name)!;
    const child = slot.oauth!;
    const install = await child.run(async (signal) => {
      if (!(await child.completeAuthorization(state, code))) return undefined;
      return this.attempt(name, slot, ++slot.generation, signal);
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    install?.();
    return install && slot.status;
  }

  /**
   * Swap a server's client and catalog entries in one synchronous step, leaving
   * every other server untouched (`always` and collision rules unchanged). The
   * previous client is closed once its calls in flight have drained.
   */
  replaceServer(name: string, server: ConnectedServer, tools: Tool[]): void {
    const slot = this.slots.get(name)!;
    for (const [qualifiedName, entry] of this.catalog) {
      if (entry.serverName === name) this.catalog.delete(qualifiedName);
    }
    this.addTools(name, slot.config, tools);
    const previous = slot.live;
    slot.live = { server, generation: slot.generation, inFlight: 0 };
    slot.status = "connected";
    if (previous) void this.retire(previous);
  }

  private async retire(live: Live): Promise<void> {
    if (live.inFlight > 0) {
      await new Promise<void>((done) => {
        live.drained = done;
        setTimeout(done, DRAIN_TIMEOUT_MS).unref();
      });
    }
    await live.server.cleanup().catch(() => undefined);
  }

  oauthChild(name: string): OAuthChild | undefined {
    return this.slots.get(name)?.oauth;
  }

  servers(): ServerSummary[] {
    return Array.from(this.slots, ([name, slot]) => ({
      name,
      transport: "command" in slot.config ? "stdio" : (slot.config.transport ?? "streamable-http"),
      status: slot.status,
      tools: slot.status === "connected" ? this.listTools().filter((e) => e.serverName === name).length : 0,
      oauth: slot.oauth !== undefined,
    }));
  }

  private needsAuthorization(serverName: string): CallToolResult {
    return toolError(`Server "${serverName}" needs authorization: open ${this.oauth?.pageUrl}`);
  }

  /** Tools of servers that are not connected (failed, needs-auth) are not listed. */
  private isListed(entry: CatalogEntry): boolean {
    const slot = this.slots.get(entry.serverName);
    return !slot || slot.status === "connected";
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
        if (!known.has(name)) log(`Warning: "always" lists unknown tool ${JSON.stringify(name)} on "${serverName}"`);
      }
    }

    for (const tool of tools) {
      const qualifiedName = prefixFn(tool.name);
      if (META_TOOL_NAMES.includes(qualifiedName) || this.catalog.has(qualifiedName)) {
        log(`Error: tool ${JSON.stringify(qualifiedName)} from "${serverName}" collides with an existing name, skipped`);
        continue;
      }

      let isAlways = always === true || (Array.isArray(always) && always.includes(tool.name));
      if (isAlways && tool.inputSchema?.type !== "object") {
        log(`Warning: ${JSON.stringify(qualifiedName)} has no object inputSchema, not listed directly`);
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
    const entries = Array.from(this.catalog.values()).filter((e) => this.isListed(e));
    if (!prefix) return entries;
    const normalized = prefix.toLowerCase();
    return entries.filter(
      (e) => e.qualifiedName.toLowerCase().startsWith(normalized),
    );
  }

  /** Tools listed directly in `tools/list` (config `always`). */
  directTools(): CatalogEntry[] {
    return Array.from(this.catalog.values()).filter((e) => e.always && this.isListed(e));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.catalog.get(name);
    if (!entry) {
      return unknownTool(name);
    }

    const slot = this.slots.get(entry.serverName);
    if (slot?.status === "needs-auth") return this.needsAuthorization(entry.serverName);
    const live = slot?.status === "connected" ? slot.live : undefined;
    if (!slot || !live) {
      return toolError(`Server for tool "${name}" is not connected.`);
    }

    live.inFlight++;
    try {
      const call = (signal?: AbortSignal) => live.server.client.callTool(
        { name: entry.originalName, arguments: args },
        undefined,
        signal && { signal },
      );
      // An OAuth child takes one operation at a time, so a refresh a call triggers never overlaps another.
      const result = slot.oauth ? await slot.oauth.run(call, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS) : await call();
      return result as CallToolResult;
    } catch (err) {
      if (slot.oauth && isAuthError(err) && live.generation === slot.generation) {
        if (slot.status === "connected") log(`"${entry.serverName}" needs authorization: open ${this.oauth!.pageUrl}`);
        slot.status = "needs-auth";
        return this.needsAuthorization(entry.serverName);
      }
      // An OAuth child's errors may carry a response body or reflect anything a server chose: only their class and code are shown.
      const detail = slot.oauth ? describeError(err) : err instanceof Error ? err.message : String(err);
      return toolError(`Tool "${name}" failed: ${detail}`);
    } finally {
      if (--live.inFlight === 0) live.drained?.();
    }
  }

  async stop(): Promise<void> {
    const lives = Array.from(this.slots.values(), (slot) => {
      slot.generation++;
      return slot.live;
    });
    await Promise.allSettled(lives.map((live) => live?.server.cleanup()));
    this.slots.clear();
    this.catalog.clear();
  }
}
