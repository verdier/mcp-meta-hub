import { randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60_000;
const MAX_SUPERSEDED = 32;

interface Pending {
  key: string;
  state: string;
  expiresAt: number;
  /** PKCE verifier of this flow: it lives and dies with the state. */
  verifier?: string;
  authorizationUrl?: string;
}

export interface Flow {
  key: string;
  verifier: string;
}

/** Why a callback state is not honoured: replaced by a newer start, or unknown, used or expired. */
export class FlowRefusedError extends Error {
  constructor(readonly reason: "superseded" | "invalid") {
    super(`OAuth authorization state is ${reason}`);
    this.name = "FlowRefusedError";
  }
}

/**
 * Pending authorizations, at most one per server: a state is random, single use,
 * compared in constant time and expires after 10 minutes. Issuing a new state
 * for a server supersedes the previous one, and each flow carries its own PKCE
 * verifier, so completing a flow never reads another flow's secret.
 */
export class AuthorizationBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly superseded = new Map<string, { key: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issueState(key: string): string {
    const previous = this.pending.get(key);
    if (previous) this.remember(previous);
    const state = randomBytes(32).toString("base64url");
    this.pending.set(key, { key, state, expiresAt: this.now() + STATE_TTL_MS });
    return state;
  }

  setVerifier(key: string, state: string, verifier: string): void {
    this.current(key, state).verifier = verifier;
  }

  publishAuthorization(key: string, state: string, url: URL): void {
    this.current(key, state).authorizationUrl = url.toString();
  }

  authorizationUrl(key: string): string | undefined {
    const pending = this.pending.get(key);
    return pending && pending.expiresAt > this.now() ? pending.authorizationUrl : undefined;
  }

  serverOf(state: string): string | undefined {
    for (const pending of this.pending.values()) if (equal(pending.state, state)) return pending.key;
    for (const [old, entry] of this.superseded) if (equal(old, state)) return entry.key;
    return undefined;
  }

  /** The flow of a callback state, consumed whatever happens next. */
  consume(state: string): Flow {
    for (const old of this.superseded.keys()) {
      if (!equal(old, state)) continue;
      this.superseded.delete(old);
      throw new FlowRefusedError("superseded");
    }
    for (const pending of this.pending.values()) {
      if (!equal(pending.state, state)) continue;
      this.pending.delete(pending.key);
      if (pending.expiresAt <= this.now() || pending.verifier === undefined) throw new FlowRefusedError("invalid");
      return { key: pending.key, verifier: pending.verifier };
    }
    throw new FlowRefusedError("invalid");
  }

  private current(key: string, state: string): Pending {
    const pending = this.pending.get(key);
    if (!pending || !equal(pending.state, state) || pending.expiresAt <= this.now()) {
      throw new Error("OAuth authorization state is invalid or expired");
    }
    return pending;
  }

  private remember(previous: Pending): void {
    const now = this.now();
    for (const [state, entry] of this.superseded) if (entry.expiresAt <= now) this.superseded.delete(state);
    if (this.superseded.size >= MAX_SUPERSEDED) this.superseded.delete(this.superseded.keys().next().value!);
    this.superseded.set(previous.state, { key: previous.key, expiresAt: previous.expiresAt });
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
