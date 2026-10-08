import { randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60_000;

interface Pending {
  key: string;
  state: string;
  expiresAt: number;
  authorizationUrl?: string;
}

/**
 * Pending authorizations, at most one per server: a state is random, single use,
 * compared in constant time and expires after 10 minutes. Issuing a new state
 * for a server cancels the previous one.
 */
export class AuthorizationBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  issueState(key: string): string {
    const state = randomBytes(32).toString("base64url");
    this.pending.set(key, { key, state, expiresAt: this.now() + STATE_TTL_MS });
    return state;
  }

  publishAuthorization(key: string, state: string, url: URL): void {
    const pending = this.pending.get(key);
    if (!pending || !equal(pending.state, state) || pending.expiresAt <= this.now()) {
      throw new Error("OAuth authorization state is invalid or expired");
    }
    pending.authorizationUrl = url.toString();
  }

  authorizationUrl(key: string): string | undefined {
    const pending = this.pending.get(key);
    return pending && pending.expiresAt > this.now() ? pending.authorizationUrl : undefined;
  }

  /** The server a callback state belongs to, consumed whatever happens next; undefined if unknown or expired. */
  consume(state: string): string | undefined {
    for (const pending of this.pending.values()) {
      if (!equal(pending.state, state)) continue;
      this.pending.delete(pending.key);
      return pending.expiresAt > this.now() ? pending.key : undefined;
    }
    return undefined;
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
