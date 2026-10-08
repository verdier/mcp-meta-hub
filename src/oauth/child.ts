import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthorizationBroker } from "./broker.js";
import { createNetworkPolicy, type NetworkPolicy } from "./network.js";
import { HubOAuthProvider } from "./provider.js";
import type { CredentialStore } from "./store.js";

export const AUTH_TIMEOUT_MS = 30_000;

export interface OAuthRuntime {
  broker: AuthorizationBroker;
  store: CredentialStore;
  redirectUrl: URL;
  /** The status page, named in every "needs authorization" message. */
  pageUrl: string;
}

export interface OAuthChildOptions {
  scopes?: string[];
  clientId?: string;
  clientName?: string;
  allowedOrigins?: string[];
  allowPrivateNetwork?: boolean;
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

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The OAuth side of one HTTP child. Every SDK `auth()` call (refresh, explicit
 * connect, code exchange) runs under one lock per child, so two refreshes never
 * race against a server that rotates refresh tokens.
 */
export class OAuthChild {
  readonly provider: HubOAuthProvider;
  readonly network: NetworkPolicy;
  private readonly endpoint: URL;
  private authTail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly name: string,
    url: string,
    private readonly options: OAuthChildOptions,
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

  /** Bind the stored record to this endpoint (a changed endpoint drops it). */
  prepare(): Promise<void> {
    return this.runtime.store.prepare(this.name, this.endpoint.toString());
  }

  /**
   * Fetch for the child's MCP transport: adds the bearer, and on a 401 refreshes
   * once (under the lock) and retries. A 401 it cannot cure goes back to the SDK,
   * which raises it as `StreamableHTTPError(401)`.
   */
  readonly fetch: FetchLike = async (url, init) => {
    const send = async () => {
      const token = (await this.provider.tokens())?.access_token;
      const headers = new Headers(init?.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return { token, response: await this.network.fetch(url, { ...init, headers }) };
    };
    const first = await send();
    if (first.response.status !== 401 || !(await this.refresh(first.token))) return first.response;
    await first.response.body?.cancel();
    return (await send()).response;
  };

  /** True if a fresh access token is now stored; false if a human must authorize. */
  private refresh(rejectedToken: string | undefined): Promise<boolean> {
    return this.withAuthLock(async () => {
      const tokens = await this.provider.tokens();
      if (tokens && tokens.access_token !== rejectedToken) return true; // refreshed while we waited
      if (!tokens?.refresh_token) return false;
      this.provider.interactive = false;
      const result = await auth(this.provider, { serverUrl: this.endpoint, fetchFn: this.network.fetch });
      if (result === "AUTHORIZED") return true;
      // The SDK falls through to a new authorization when the token endpoint is down:
      // a refresh token still stored means nothing rejected it, so this is an outage.
      if ((await this.provider.tokens())?.refresh_token) {
        throw new Error(`OAuth refresh for "${this.name}" failed: the authorization server is unavailable`);
      }
      return false;
    });
  }

  /**
   * Explicit "connect": drop tokens and discovery (and the client registration if it
   * does not carry the current redirect URL), then start an authorization. Resolves
   * to the authorization URL the broker published.
   */
  startAuthorization(): Promise<string> {
    return this.withAuthLock(async () => {
      const info = (await this.provider.clientInformation()) as { redirect_uris?: string[] } | undefined;
      const compatible = this.options.clientId !== undefined || info?.redirect_uris?.includes(this.runtime.redirectUrl.toString());
      if (!compatible) await this.provider.invalidateCredentials("client");
      await this.provider.invalidateCredentials("tokens");
      await this.provider.invalidateCredentials("discovery");
      this.provider.interactive = true;
      try {
        await auth(this.provider, { serverUrl: this.endpoint, fetchFn: this.network.fetch });
      } finally {
        this.provider.interactive = false;
      }
      const url = this.runtime.broker.authorizationUrl(this.name);
      if (!url) throw new Error(`No authorization URL for "${this.name}"`);
      return url;
    });
  }

  /** Exchange an authorization code (the SDK's `finishAuth`, without a transport). */
  completeAuthorization(code: string): Promise<void> {
    return this.withAuthLock(async () => {
      const result = await auth(this.provider, { serverUrl: this.endpoint, authorizationCode: code, fetchFn: this.network.fetch });
      if (result !== "AUTHORIZED") throw new UnauthorizedError("Authorization code was not accepted");
    });
  }

  private withAuthLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.authTail.then(() => withTimeout(operation(), AUTH_TIMEOUT_MS, `OAuth operation for "${this.name}" timed out`));
    this.authTail = run.catch(() => undefined);
    return run;
  }
}
