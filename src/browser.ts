import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hub } from "./hub.js";
import { FlowRefusedError } from "./oauth/broker.js";
import { describeError, type OAuthRuntime } from "./oauth/child.js";

const log = (msg: string) => console.error(`[mcp-meta-hub] ${msg}`);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const START = /^\/oauth\/start\/([a-zA-Z0-9](?:[-a-zA-Z0-9]*[a-zA-Z0-9])?)$/;
/** Parameters an authorization server may add to the callback; read never, tolerated once. */
const IGNORED_CALLBACK_PARAMS = new Set(["iss", "scope", "error_description", "error_uri"]);

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // `https:` in form-action: browsers apply it to the redirect that follows the "connect" form.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'",
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, status: number, title: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, ...headers, "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>`
    + "<style>body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem}td,th{padding:.3rem .8rem;text-align:left}</style>"
    + `</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
}

function message(res: ServerResponse, status: number, title: string, text: string): void {
  page(res, status, title, `<p>${escapeHtml(text)}</p>`);
}

/** `host[:port]` and nothing else: no userinfo, path, query or fragment to be parsed away. */
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

function hostname(req: IncomingMessage): string | undefined {
  return HOST.exec(req.headers.host ?? "")?.[1]?.toLowerCase();
}

function callbackParams(search: URLSearchParams): { state: string; code?: string; error?: string } | undefined {
  const keys = Array.from(search.keys());
  if (new Set(keys).size !== keys.length) return undefined;
  if (keys.some((k) => !["state", "code", "error"].includes(k) && !IGNORED_CALLBACK_PARAMS.has(k))) return undefined;
  const state = search.get("state");
  const code = search.get("code") ?? undefined;
  const error = search.get("error") ?? undefined;
  if (!state || state.length < 32 || state.length > 512) return undefined;
  if ((code === undefined) === (error === undefined)) return undefined;
  if ((code !== undefined && (code.length < 1 || code.length > 8192)) || (error !== undefined && error.length > 256)) return undefined;
  return { state, code, error };
}

/**
 * Status page, "connect" and OAuth callback: dispatched by exact path before the
 * bearer gate, with their own Host allowlist. Returns false for any other path.
 */
export function createBrowserSurface(hub: Hub, oauth: OAuthRuntime) {
  const allowedHosts = new Set([...LOOPBACK, oauth.redirectUrl.hostname.toLowerCase()]);

  function statusPage(res: ServerResponse): void {
    const rows = hub.servers().map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${s.transport}</td><td>${s.status}</td><td>${s.tools}</td><td>${
      s.oauth ? `<form method="post" action="/oauth/start/${escapeHtml(s.name)}"><button>Connect</button></form>` : ""
    }</td></tr>`).join("");
    page(res, 200, "mcp-meta-hub", `<table><tr><th>Server</th><th>Transport</th><th>Status</th><th>Tools</th><th></th></tr>${rows}</table>`
      + `<p>Connect works from ${escapeHtml(oauth.redirectUrl.origin)} only.</p>`,
    // Under no-referrer a browser sends `Origin: null` on the form's POST and the connect check can never pass.
    { "Referrer-Policy": "same-origin" });
  }

  async function start(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    if (req.headers.origin !== oauth.redirectUrl.origin) {
      message(res, 403, "Forbidden", "This form must be submitted from the hub's own page.");
      return;
    }
    const child = hub.oauthChild(name);
    if (!child) {
      message(res, 404, "Not found", "No OAuth server by that name.");
      return;
    }
    try {
      const url = await hub.startAuthorization(name);
      log(`OAuth authorization started for "${name}"`);
      res.writeHead(303, { ...HEADERS, Location: url });
      res.end();
    } catch (err) {
      log(`OAuth authorization could not start for "${name}": ${describeError(err)}`);
      message(res, 502, "Authorization unavailable", "The authorization could not start. See the hub's log.");
    }
  }

  async function callback(res: ServerResponse, search: URLSearchParams): Promise<void> {
    const params = callbackParams(search);
    const name = params && oauth.broker.serverOf(params.state);
    if (!params || !name || !hub.oauthChild(name)) {
      message(res, 400, "Authorization failed", "The callback is invalid, expired or already used.");
      return;
    }
    let status;
    try {
      status = await hub.completeAuthorization(name, params.state, params.error === undefined ? params.code : undefined);
    } catch (err) {
      if (err instanceof FlowRefusedError && err.reason === "superseded") {
        log(`OAuth callback for "${name}" refused: superseded by a newer start`);
        message(res, 400, "Authorization superseded", "A newer authorization was started for this server. Start again.");
      } else if (err instanceof FlowRefusedError) {
        message(res, 400, "Authorization failed", "The callback is invalid, expired or already used.");
      } else {
        log(`OAuth code exchange failed for "${name}": ${describeError(err)}`);
        message(res, 400, "Authorization failed", "The authorization server rejected the exchange.");
      }
      return;
    }
    if (status === undefined) {
      log(`OAuth authorization for "${name}" was not granted`);
      message(res, 400, "Authorization failed", "The authorization was not granted.");
      return;
    }
    log(`OAuth authorization completed for "${name}", now ${status}`);
    if (status === "connected") message(res, 200, "Connected", "The server is connected. You can close this window.");
    else message(res, 502, "Authorized, not connected", "The authorization succeeded but the server could not be reached. See the hub's log.");
  }

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://hub.invalid");
    } catch {
      return false;
    }
    const startMatch = START.exec(url.pathname);
    const route = url.pathname === "/" ? "status" : url.pathname === "/oauth/callback" ? "callback" : startMatch ? "start" : undefined;
    if (!route) return false;

    req.resume();
    const host = hostname(req);
    if (!host || !allowedHosts.has(host)) {
      message(res, 403, "Forbidden", "Unknown host.");
      return true;
    }
    const method = route === "start" ? "POST" : "GET";
    if (req.method !== method) {
      res.writeHead(405, { ...HEADERS, Allow: method });
      res.end();
      return true;
    }
    const done = (p: Promise<void>) => void p.catch((err) => {
      log(`Browser request failed: ${err}`);
      if (!res.headersSent) message(res, 500, "Error", "Internal error.");
    });
    if (route === "status") statusPage(res);
    else if (route === "start") done(start(req, res, startMatch![1]));
    else done(callback(res, url.searchParams));
    return true;
  };
}
