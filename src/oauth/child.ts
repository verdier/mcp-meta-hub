import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChildOAuthOptions } from "../config.js";
import { FlowRefusedError, type AuthorizationBroker, type Flow } from "./broker.js";
import { HubError, OAuthTimeoutError } from "./errors.js";
import { operation, type Operation } from "./operation.js";
import { createNetworkPolicy, type NetworkPolicy } from "./network.js";
import { HubOAuthProvider } from "./provider.js";
import type { CredentialStore } from "./store.js";

export const CONNECT_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 60_000;

export interface OAuthRuntime {
  broker: AuthorizationBroker;
  store: CredentialStore;
  redirectUrl: URL;
  /** The status page, named in every "needs authorization" message. */
  pageUrl: string;
}

/**
 * What sends a child to `needs-auth`: no usable grant, the SDK refusing a second
 * 401, or a grant/client the authorization server rejected. Anything else (network,
 * 5xx, timeout) is a failure and never asks a human for consent.
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof UnauthorizedError
    || (error instanceof StreamableHTTPError && error.code === 401)
    || error instanceof InvalidGrantError
    || error instanceof InvalidClientError
    || error instanceof UnauthorizedClientError;
}

/**
 * An error as it may be logged or shown to an agent: the message of the hub's own
 * errors, otherwise only the class and HTTP status, never a message that SDK and
 * remote errors can fill with a response body.
 */
export function describeError(error: unknown): string {
  if (error instanceof HubError) return error.message;
  if (error instanceof McpError) return `McpError (code ${error.code})`;
  if (error instanceof StreamableHTTPError) return `${error.name} (HTTP ${error.code})`;
  return error instanceof Error ? error.name : "error";
}

/**
 * The OAuth side of one HTTP child. The SDK transport does the protocol; this
 * class guarantees nothing runs in parallel on one child: every operation is an
 * item of one serial queue, which advances only when the item's work has really
 * settled (a caller may be told about a timeout earlier, never the queue).
 */
export class OAuthChild {
  readonly provider: HubOAuthProvider;
  readonly network: NetworkPolicy;
  private readonly endpoint: URL;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    url: string,
    private readonly options: ChildOAuthOptions,
    private readonly runtime: OAuthRuntime,
  ) {
    this.endpoint = new URL(url);
    this.network = createNetworkPolicy({
      approvedOrigins: [this.endpoint.origin, ...(options.allowedOrigins ?? [])],
      allowPrivateNetwork: options.allowPrivateNetwork,
    });
    this.provider = new HubOAuthProvider(
      name,
      { clientId: options.clientId, scopes: options.scopes ?? [], clientName: options.clientName ?? "mcp-meta-hub" },
      runtime.store,
      runtime.broker,
      runtime.redirectUrl,
      (u) => this.network.assertUrl(u),
    );
  }

  prepare(): Promise<void> {
    return this.runtime.store.prepare(this.name, this.endpoint.toString());
  }

  /**
   * The guarded fetch of this child's traffic. It carries the signal of the queue
   * item it was started under, for as long as anything that item started runs.
   * The optional standalone GET stream of the MCP endpoint is declined (405, "no
   * stream"): its reconnections would authenticate outside the queue.
   */
  readonly fetch: FetchLike = (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET" && new URL(url.toString()).href === this.endpoint.href) {
      return Promise.resolve(new Response(null, { status: 405, headers: { Allow: "POST" } }));
    }
    const current = operation.getStore();
    if (!current) return this.network.fetch(url, init);
    const signal = current.controller.signal;
    const request = this.network.fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    const settled = request.then(() => undefined, () => undefined).finally(() => current.pending.delete(settled));
    current.pending.add(settled);
    return request;
  };

  /**
   * Run `work` once everything queued before it has settled. Rejects with a
   * timeout after `timeoutMs` of running, aborting the requests of `work` and of
   * whatever it detached; the queue moves on when `work` and those requests are done.
   */
  run<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tail = this.tail.then(async () => {
        const current: Operation = { controller: new AbortController(), pending: new Set() };
        const timer = setTimeout(() => {
          current.controller.abort();
          reject(new OAuthTimeoutError());
        }, timeoutMs);
        try {
          resolve(await operation.run(current, () => work(current.controller.signal)));
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timer);
          while (current.pending.size > 0) await Promise.all(current.pending);
        }
      });
    });
  }

  /**
   * Inside the queue: drop tokens and discovery (and the client registration unless
   * it carries the current redirect URL), run `work` so the SDK starts a fresh
   * authorization, and resolve to the URL the provider published.
   */
  async startAuthorization(work: () => Promise<unknown>): Promise<string> {
    const info = (await this.provider.clientInformation()) as { redirect_uris?: string[] } | undefined;
    const compatible = this.options.clientId !== undefined || info?.redirect_uris?.includes(this.runtime.redirectUrl.toString());
    if (!compatible) await this.provider.invalidateCredentials("client");
    await this.provider.invalidateCredentials("tokens");
    await this.provider.invalidateCredentials("discovery");
    this.provider.interactive = true;
    try {
      // The server answers 401; the SDK discovers, registers and hands the URL to the provider.
      await work().catch((error) => {
        if (!isAuthError(error)) throw error;
      });
    } finally {
      this.provider.interactive = false;
    }
    const url = this.runtime.broker.authorizationUrl(this.name);
    if (!url) throw new HubError(`The server "${this.name}" did not ask for authorization`);
    return url;
  }

  /** Inside the queue: consume the flow of `state` and exchange `code` with that flow's own verifier. */
  async completeAuthorization(state: string, code: string | undefined): Promise<boolean> {
    const flow: Flow = this.runtime.broker.consume(state);
    if (flow.key !== this.name) throw new FlowRefusedError("invalid");
    if (code === undefined) return false;
    this.provider.exchangeVerifier = flow.verifier;
    try {
      const result = await auth(this.provider, { serverUrl: this.endpoint, authorizationCode: code, fetchFn: this.fetch });
      if (result !== "AUTHORIZED") throw new UnauthorizedError("Authorization code was not accepted");
    } finally {
      this.provider.exchangeVerifier = undefined;
    }
    return true;
  }
}
