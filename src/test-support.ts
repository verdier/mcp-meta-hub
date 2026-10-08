/** Helpers shared by the HTTP and OAuth suites. */
import { request } from "node:http";
import { createServer } from "node:net";
import { strict as assert } from "node:assert";

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

/** Raw request: fetch cannot override the Host header. */
export function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; type: string; headers: Record<string, unknown>; body: string }> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path: opts.path ?? "/mcp", method: opts.method ?? "POST", headers: opts.headers }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => res({ status: r.statusCode!, type: String(r.headers["content-type"]), headers: r.headers, body }));
    });
    req.once("error", rej);
    req.end(opts.body);
  });
}

/** The user at the hub's page and at the provider. */
export function browser(hubOrigin: string, server = "fake") {
  const start = (name = server, origin: string | null = hubOrigin) =>
    fetch(`${hubOrigin}/oauth/start/${name}`, { method: "POST", redirect: "manual", headers: origin ? { Origin: origin } : {} });
  /** Follow the authorization URL to the callback URL. */
  const consent = async (authorizationUrl: string) => {
    const r = await fetch(authorizationUrl, { redirect: "manual" });
    assert.strictEqual(r.status, 302, "the fake refused the authorization request");
    return r.headers.get("location")!;
  };
  /** Start, and play the provider: the callback URL the browser would be sent to. */
  const begin = async () => {
    const s = await start();
    assert.strictEqual(s.status, 303);
    return consent(s.headers.get("location")!);
  };
  const authorize = async () => fetch(await begin());
  return { start, consent, begin, authorize };
}
