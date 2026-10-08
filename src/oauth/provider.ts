import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationBroker } from "./broker.js";
import type { CredentialRecord, CredentialStore } from "./store.js";

export interface ProviderOptions {
  clientId?: string;
  scopes: string[];
  clientName: string;
}

/**
 * The SDK's OAuth client provider for one child. A dynamically registered public
 * client (`token_endpoint_auth_method: none`) unless a `clientId` is configured.
 * It never opens anything: in interactive mode it publishes the authorization URL
 * to the broker; otherwise (a background refresh) it leaves no trace, so a failed
 * refresh cannot cancel an authorization a human has started.
 */
export class HubOAuthProvider implements OAuthClientProvider {
  /** Set by the child coordinator, under its auth lock, for an explicit "connect". */
  interactive = false;
  private activeState?: string;
  private verifier?: string;

  constructor(
    private readonly key: string,
    private readonly options: ProviderOptions,
    private readonly store: CredentialStore,
    private readonly broker: AuthorizationBroker,
    readonly redirectUrl: URL,
    private readonly assertAuthorizationUrl: (url: URL) => Promise<void>,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.options.clientName,
      ...(this.options.scopes.length > 0 && { scope: this.options.scopes.join(" ") }),
    };
  }

  state(): string {
    this.activeState = this.interactive ? this.broker.issueState(this.key) : randomBytes(32).toString("base64url");
    return this.activeState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.clientId) return { client_id: this.options.clientId };
    return (await this.store.load(this.key))?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.merge({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load(this.key))?.tokens;
  }

  /** A response without a refresh token keeps the previous one. */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update(this.key, (current) => {
      const record = prepared(current);
      const previous = record.tokens?.refresh_token;
      return { ...record, tokens: tokens.refresh_token === undefined && previous !== undefined ? { ...tokens, refresh_token: previous } : tokens };
    });
    this.verifier = undefined;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) return;
    if (!this.activeState) throw new Error("OAuth provider did not issue a state");
    await this.assertAuthorizationUrl(url);
    this.broker.publishAuthorization(this.key, this.activeState, url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.interactive) this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("OAuth PKCE verifier is missing");
    return this.verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.merge({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load(this.key))?.discoveryState;
  }

  /**
   * Called by the SDK on `invalid_client` (all) and `invalid_grant` (tokens): this
   * is what turns those errors into a fresh authorization instead of a throw.
   * Fields are cleared, the record and its endpoint binding are kept.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "verifier") return;
    await this.store.update(this.key, (current) => {
      const next = { ...prepared(current) };
      if (scope === "all" || scope === "client") delete next.clientInformation;
      if (scope === "all" || scope === "tokens") delete next.tokens;
      if (scope === "all" || scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  private async merge(patch: Partial<Omit<CredentialRecord, "endpoint">>): Promise<void> {
    await this.store.update(this.key, (current) => ({ ...prepared(current), ...patch }));
  }
}

function prepared(record: CredentialRecord | undefined): CredentialRecord {
  if (!record) throw new Error("OAuth credential record has not been prepared");
  return record;
}
