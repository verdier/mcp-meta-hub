/**
 * An error whose message the hub wrote itself: safe to log and to show. Every
 * other error (SDK, network, remote server) can carry a response body, so only
 * its class is ever surfaced.
 */
export class HubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubError";
  }
}

/** An item of an OAuth child's queue ran past its time (its requests were aborted). */
export class OAuthTimeoutError extends HubError {
  constructor() {
    super("timed out");
    this.name = "OAuthTimeoutError";
  }
}
