import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface ResolvedAddress {
  address: string;
  family?: number;
}

type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

type PinnedRequest = (url: URL, init: RequestInit, addresses: readonly ResolvedAddress[]) => Promise<Response>;

export interface NetworkPolicyOptions {
  approvedOrigins: readonly string[];
  /** Lift the public-address rule, and allow plain HTTP to non-public addresses only. */
  allowPrivateNetwork?: boolean;
  /** Test seams. Production uses the DNS resolver and the pinned undici dispatcher. */
  request?: PinnedRequest;
  resolveHost?: HostResolver;
  maxRedirects?: number;
  connectTimeoutMs?: number;
}

export interface NetworkPolicy {
  fetch: FetchLike;
  assertUrl(url: URL): Promise<void>;
}

/**
 * Outbound guard for everything an OAuth child sends (MCP, discovery, registration,
 * token, refresh) and for the authorization URL handed to the browser: approved
 * origins only, HTTPS, no credentials or fragment, public addresses pinned into the
 * connection, every redirect revalidated and none for a non-idempotent request.
 */
export function createNetworkPolicy(options: NetworkPolicyOptions): NetworkPolicy {
  const allowPrivate = options.allowPrivateNetwork === true;
  const approved = new Set(options.approvedOrigins.map(approvedOrigin));
  const request = options.request
    ?? ((url, init, addresses) => pinnedRequest(url, init, addresses, options.connectTimeoutMs ?? 10_000));
  const resolveHost = options.resolveHost ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  const maxRedirects = options.maxRedirects ?? 3;

  const resolveApprovedUrl = async (url: URL): Promise<readonly ResolvedAddress[]> => {
    assertUrlShape(url);
    if (!approved.has(url.origin)) throw new Error(`Network policy rejected origin ${url.origin}`);
    const hostname = stripBrackets(url.hostname);
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveHost(hostname);
    if (addresses.length === 0) throw new Error(`Host did not resolve: ${hostname}`);
    for (const { address } of addresses) {
      const isPublic = isPublicAddress(address);
      if (!isPublic && !allowPrivate) throw new Error(`Network policy rejected non-public address ${address}`);
      if (isPublic && url.protocol !== "https:") throw new Error("Network policy rejected plain HTTP to a public address");
    }
    return addresses;
  };

  const guardedFetch: FetchLike = async (input, requestInit) => {
    let current = new URL(input.toString());
    const method = (requestInit?.method ?? "GET").toUpperCase();
    const headers = new Headers(requestInit?.headers);
    const init: RequestInit = { ...requestInit, headers, redirect: "manual" };
    for (let redirects = 0; ; redirects++) {
      const addresses = await resolveApprovedUrl(current);
      const response = await request(current, init, addresses);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      if (method !== "GET" && method !== "HEAD") throw new Error("Redirect refused for a non-idempotent request");
      if (redirects >= maxRedirects) throw new Error("Redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without Location");
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        if (headers.has("mcp-session-id") || headers.has("last-event-id")) {
          throw new Error("Cross-origin redirect refused for an MCP session request");
        }
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      current = next;
    }
  };

  return { fetch: guardedFetch, assertUrl: async (url) => void (await resolveApprovedUrl(url)) };
}

async function pinnedRequest(
  url: URL,
  init: RequestInit,
  addresses: readonly ResolvedAddress[],
  connectTimeoutMs: number,
): Promise<Response> {
  const dispatcher: Dispatcher = new Agent({
    connect: { lookup: pinnedLookup(url.hostname, addresses), timeout: connectTimeoutMs },
    autoSelectFamily: false,
  });
  try {
    const response = await undiciFetch(url, { ...(init as object), dispatcher, redirect: "manual" });
    // Graceful close: the body stays readable, the dispatcher (and its DNS answer) is never reused.
    void dispatcher.close().catch(() => undefined);
    return new Response(response.body as ReadableStream | null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as unknown as Headers,
    });
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
    throw error;
  }
}

function pinnedLookup(expectedHostname: string, addresses: readonly ResolvedAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== stripBrackets(expectedHostname)) {
      callback(dnsError(`Unexpected hostname ${hostname}`), "", 0);
      return;
    }
    const family = typeof options.family === "number" ? options.family : 0;
    const selected = addresses.find((a) => family === 0 || family === (a.family ?? isIP(a.address)));
    if (!selected) {
      callback(dnsError(`No vetted address for ${hostname}`), "", 0);
      return;
    }
    callback(null, selected.address, selected.family ?? isIP(selected.address));
  };
}

function dnsError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "ENOTFOUND" });
}

/** Shape is checked per request, so a bad endpoint fails its child instead of the hub. */
function approvedOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "") throw new Error(`Approved URL is not an origin: ${value}`);
  return url.origin;
}

/** HTTPS is enforced per address: plain HTTP never reaches a public one. */
function assertUrlShape(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Network policy requires HTTP(S)");
  if (url.username || url.password) throw new Error("Network policy rejected credentials in the URL");
  if (url.hash) throw new Error("Network policy rejected a fragment in the URL");
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isUnsafeIpv4(address);
  if (version === 6) return !isUnsafeIpv6(address);
  return false;
}

function isUnsafeIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function isUnsafeIpv6(address: string): boolean {
  const w = expandIpv6(address);
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  return (
    zeros(0, 6) // unspecified, loopback, IPv4-compatible
    || (zeros(0, 5) && w[5] === 0xffff) // IPv4-mapped
    || (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) // IPv4-translated
    || (w[0] === 0x0064 && w[1] === 0xff9b && (zeros(2, 6) || w[2] === 0x0001)) // NAT64
    || w[0] === 0x2002 // 6to4
    || (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0x0db8)) // Teredo, documentation
    || (w[0] & 0xfe00) === 0xfc00 // unique local
    || (w[0] & 0xffc0) === 0xfe80 // link-local
    || (w[0] & 0xffc0) === 0xfec0 // site-local
    || (w[0] & 0xff00) === 0xff00 // multicast
  );
}

function expandIpv6(address: string): number[] {
  const [left = "", right = ""] = address.toLowerCase().split("::");
  const side = (s: string) => (s ? s.split(":").flatMap((part) => {
    if (!part.includes(".")) return [Number.parseInt(part, 16)];
    const b = part.split(".").map(Number);
    return [((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0)];
  }) : []);
  const l = side(left);
  const r = side(right);
  return [...l, ...Array<number>(Math.max(0, 8 - l.length - r.length)).fill(0), ...r];
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
