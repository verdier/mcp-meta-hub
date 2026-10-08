import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HubError } from "./errors.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/** The only headers that follow a redirect to another origin (credentials, cookies and custom headers do not). */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "content-type"]);

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
    if (!approved.has(url.origin)) throw new HubError(`Network policy rejected origin ${url.origin}`);
    const hostname = stripBrackets(url.hostname);
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveHost(hostname);
    if (addresses.length === 0) throw new HubError(`Host did not resolve: ${hostname}`);
    for (const { address } of addresses) {
      const isPublic = isPublicAddress(address);
      if (!isPublic && !allowPrivate) throw new HubError(`Network policy rejected non-public address ${address}`);
      if (isPublic && url.protocol !== "https:") throw new HubError("Network policy rejected plain HTTP to a public address");
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
      if (method !== "GET" && method !== "HEAD") throw new HubError("Redirect refused for a non-idempotent request");
      if (redirects >= maxRedirects) throw new HubError("Redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location) throw new HubError("Redirect without Location");
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        if (headers.has("mcp-session-id") || headers.has("last-event-id")) {
          throw new HubError("Cross-origin redirect refused for an MCP session request");
        }
        for (const name of Array.from(headers.keys())) if (!CROSS_ORIGIN_HEADERS.has(name)) headers.delete(name);
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

/** The origin of `value` if it is nothing but an http(s) origin (a trailing slash is fine), else undefined. */
export function pureOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const bare = (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      && url.pathname === "/" && !value.includes("?") && !value.includes("#");
    return bare ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Shape is checked per request, so a bad endpoint fails its child instead of the hub. */
function approvedOrigin(value: string): string {
  const origin = pureOrigin(value);
  if (!origin) throw new HubError(`Approved URL is not an origin: ${value}`);
  return origin;
}

/** HTTPS is enforced per address: plain HTTP never reaches a public one. */
function assertUrlShape(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HubError("Network policy requires HTTP(S)");
  if (url.username || url.password) throw new HubError("Network policy rejected credentials in the URL");
  if (url.hash) throw new HubError("Network policy rejected a fragment in the URL");
}

/** True for a globally routable unicast address; throws on anything that is not an IP address. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isUnsafeIpv4(address);
  if (version === 6) return !isUnsafeIpv6(address);
  throw new HubError(`Not an IP address: ${address}`);
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
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

/**
 * Only global unicast space (2000::/3) is public, minus the special-purpose
 * blocks inside it. Everything outside it (unspecified, loopback, IPv4-mapped,
 * NAT64, discard, unique local, link-local, multicast, SRv6 and the unallocated
 * rest) is refused as a whole.
 */
function isUnsafeIpv6(address: string): boolean {
  const [w0 = 0, w1 = 0] = expandIpv6(address);
  return (
    (w0 & 0xe000) !== 0x2000
    || (w0 === 0x2001 && (w1 < 0x0200 || w1 === 0x0db8)) // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID...), documentation
    || w0 === 0x2002 // 6to4
    || (w0 === 0x3fff && w1 < 0x1000) // documentation, 3fff::/20
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
