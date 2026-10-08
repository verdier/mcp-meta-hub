import { AsyncLocalStorage } from "node:async_hooks";
import { HubError } from "./errors.js";

/**
 * The queue item an asynchronous continuation belongs to. It is carried by
 * AsyncLocalStorage, so work the SDK detaches from the item (a request that
 * rejected early on abort, a discovery fallback, a notification) still sees the
 * item's signal after the item has timed out.
 */
export interface Operation {
  controller: AbortController;
  /** Requests started on behalf of the item that have not settled yet. */
  pending: Set<Promise<unknown>>;
}

export const operation = new AsyncLocalStorage<Operation>();

/** Throws if the current operation was cancelled: nothing may be persisted on its behalf. */
export function assertNotCancelled(): void {
  if (operation.getStore()?.controller.signal.aborted) throw new HubError("operation cancelled");
}
