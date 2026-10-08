import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ChildOAuthOptions } from "../config.js";
import { assertNotCancelled } from "./operation.js";
import { HubError } from "./errors.js";
import type { AuthorizationBroker } from "./broker.js";
import type { CredentialRecord, CredentialStore } from "./store.js";

export type ProviderOptions = Pick<ChildOAuthOptions, "clientId"> & { scopes: string[]; clientName: string };

/**
 * The SDK's OAuth client provider for one child (a public client unless a
 * `clientId` is configured). It opens nothing: interactively it publishes the
 * authorization URL to the broker, in the background it leaves no trace, so a
 * failed refresh cannot cancel an authorization a human started. PKCE verifiers
 * belong to flows (the broker); nothing is persisted for a cancelled queue item.
 */
export class HubOAuthProvider implements OAuthClientProvider {
  interactive = false;
  exchangeVerifier?: string;
  private activeState?: string;

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

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.merge({ tokens });
  }

  /**
   * Interactive: publish the URL for the human. In the background nothing is
   * published (the SDK then reports "unauthorized", which means needs-auth) unless
   * a refresh token is still stored: then nothing rejected the grant, the refresh
   * simply could not complete, and that is an outage, never a reason to ask for consent.
   */
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) {
      if ((await this.tokens())?.refresh_token) throw new HubError("the authorization server is unavailable");
      return;
    }
    if (!this.activeState) throw new HubError("OAuth provider did not issue a state");
    await this.assertAuthorizationUrl(url);
    this.broker.publishAuthorization(this.key, this.activeState, url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.interactive && this.activeState) this.broker.setVerifier(this.key, this.activeState, codeVerifier);
  }

  codeVerifier(): string {
    if (!this.exchangeVerifier) throw new Error("OAuth PKCE verifier is missing");
    return this.exchangeVerifier;
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
   * (`verifier` is a no-op: verifiers belong to flows.) Fields are cleared, the record and its endpoint binding are kept.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") return;
    await this.store.update(this.key, (current) => {
      assertNotCancelled();
      const next = { ...prepared(current) };
      if (scope === "all" || scope === "client") delete next.clientInformation;
      if (scope === "all" || scope === "tokens") delete next.tokens;
      if (scope === "all" || scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  private async merge(patch: Partial<Omit<CredentialRecord, "endpoint">>): Promise<void> {
    await this.store.update(this.key, (current) => {
      assertNotCancelled();
      return { ...prepared(current), ...patch };
    });
  }
}

function prepared(record: CredentialRecord | undefined): CredentialRecord {
  if (!record) throw new Error("OAuth credential record has not been prepared");
  return record;
}
