/**
 * End-to-end HTTP tests: spawn the built hub with the weather example child
 * and talk to it over stateless Streamable HTTP with bearer auth.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

type TextContent = { type: string; text: string };

const TOKEN_A = "token-a-0123456789";
const TOKEN_B = "token-b-0123456789";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

function startHub(configPath: string, port: number): Promise<ChildProcess> {
  const child = spawn("node", [resolve(projectRoot, "dist/index.js"), configPath, "--http", `127.0.0.1:${port}`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HUB_TOKEN_A: TOKEN_A,
      HUB_TOKEN_B: TOKEN_B,
      TEST_PARENT_API_KEY: "parent-key",
      TEST_PARENT_SECRET: "parent-secret",
      TEST_DECLARED_TOKEN: "declared-value",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((res, rej) => {
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.includes("Listening on")) res(child);
    });
    child.once("exit", (code) => rej(new Error(`hub exited early (${code}): ${stderr}`)));
  });
}

function stopHub(child: ChildProcess): Promise<void> {
  return new Promise((res) => {
    child.removeAllListeners("exit");
    child.once("exit", () => res());
    child.kill("SIGTERM");
  });
}

async function connect(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Raw request: fetch cannot override the Host header. */
function raw(
  port: number,
  opts: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: opts.method ?? "POST", headers: opts.headers }, (r) => {
      let body = "";
      r.on("data", (d) => (body += d));
      r.on("end", () => res({ status: r.statusCode!, type: String(r.headers["content-type"]), body }));
    });
    req.once("error", rej);
    req.end(opts.body);
  });
}

async function envReport(client: Client): Promise<{ env: Record<string, string>; pid: number }> {
  const r = await client.callTool({ name: "call_tool", arguments: { name: "envchild__env_report" } });
  return JSON.parse((r.content as TextContent[])[0].text);
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e}`);
      failed++;
    }
  }

  console.log("mcp-meta-hub HTTP e2e tests\n");

  const configPath = resolve(projectRoot, "test/http.generated.config.json");
  await writeFile(configPath, JSON.stringify({
    servers: {
      weather: { command: "node", args: ["examples/weather/dist/index.js"], always: ["list_cities"] },
      envchild: {
        command: "node",
        args: ["test/env-child.mjs"],
        env: { DECLARED_LITERAL: "lit", DECLARED_REF: "$TEST_DECLARED_TOKEN" },
      },
    },
    clients: { alpha: { tokenEnv: "HUB_TOKEN_A" }, beta: { tokenEnv: "HUB_TOKEN_B" } },
  }));

  const port = await freePort();
  let hub = await startHub(configPath, port);
  const url = `http://127.0.0.1:${port}/mcp`;
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(rpc),
    });

  try {
    await test("401 without bearer, with WWW-Authenticate", async () => {
      const res = await post({});
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.headers.get("www-authenticate"), "Bearer");
    });

    await test("401 with a wrong bearer", async () => {
      const res = await post({ Authorization: "Bearer nope" });
      assert.strictEqual(res.status, 401);
    });

    await test("every method needs the bearer, not only POST", async () => {
      for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
        const res = await fetch(url, { method });
        assert.strictEqual(res.status, 401, method);
      }
    });

    await test("GET and DELETE answer 405 once authenticated", async () => {
      for (const method of ["GET", "DELETE"]) {
        const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN_A}` } });
        assert.strictEqual(res.status, 405);
      }
    });

    const json = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

    await test("a foreign Host header is rejected even when authenticated", async () => {
      const r = await raw(port, {
        headers: { ...json, Host: "evil.example", Authorization: `Bearer ${TOKEN_A}` },
        body: JSON.stringify(rpc),
      });
      assert.strictEqual(r.status, 403);
    });

    await test("unauthenticated malformed JSON gets 401, not a body-parser error", async () => {
      const r = await raw(port, { headers: json, body: "{" });
      assert.strictEqual(r.status, 401);
      assert.ok(r.type.includes("application/json"));
    });

    await test("authenticated malformed JSON gets a JSON-RPC parse error", async () => {
      const r = await raw(port, { headers: { ...json, Authorization: `Bearer ${TOKEN_A}` }, body: "{" });
      assert.strictEqual(r.status, 400);
      assert.ok(r.type.includes("application/json"));
      assert.strictEqual(JSON.parse(r.body).error.code, -32700);
    });

    await test("responses do not advertise Express", async () => {
      const res = await post({});
      assert.strictEqual(res.headers.get("x-powered-by"), null);
    });

    await test("call_tool on a meta-tool name explains itself", async () => {
      const client = await connect(port, TOKEN_A);
      const r = await client.callTool({ name: "call_tool", arguments: { name: "list_tools" } });
      assert.ok(r.isError);
      assert.ok((r.content as TextContent[])[0].text.includes("meta-tool"));
      await client.close();
    });

    await test("stdio child env: secrets scrubbed, declared kept, PATH/HOME kept", async () => {
      const client = await connect(port, TOKEN_A);
      const { env } = await envReport(client);
      for (const name of ["TEST_PARENT_API_KEY", "TEST_PARENT_SECRET", "HUB_TOKEN_A", "HUB_TOKEN_B", "TEST_DECLARED_TOKEN"]) {
        assert.strictEqual(env[name], undefined, `${name} leaked to the child`);
      }
      assert.strictEqual(env.DECLARED_LITERAL, "lit");
      assert.strictEqual(env.DECLARED_REF, "declared-value");
      assert.ok(env.PATH);
      assert.ok(env.HOME);
      await client.close();
    });

    await test("two clients share one child process", async () => {
      const [a, b] = await Promise.all([connect(port, TOKEN_A), connect(port, TOKEN_B)]);
      const [ra, rb] = await Promise.all([envReport(a), envReport(b)]);
      assert.strictEqual(ra.pid, rb.pid);
      await Promise.all([a.close(), b.close()]);
    });

    await test("tools/list shows the meta-tools and the always tool only", async () => {
      const client = await connect(port, TOKEN_A);
      const { tools } = await client.listTools();
      assert.deepStrictEqual(tools.map((t) => t.name).sort(), ["call_tool", "list_tools", "weather__list_cities"]);
      const direct = tools.find((t) => t.name === "weather__list_cities")!;
      assert.strictEqual(direct.inputSchema.type, "object");
      await client.close();
    });

    await test("direct call of the always tool", async () => {
      const client = await connect(port, TOKEN_A);
      const result = await client.callTool({ name: "weather__list_cities", arguments: {} });
      const cities = JSON.parse((result.content as TextContent[])[0].text);
      assert.ok(cities.some((c: { name: string }) => c.name === "paris"));
      await client.close();
    });

    await test("a non-always tool is not callable directly but works via call_tool", async () => {
      const client = await connect(port, TOKEN_A);
      const direct = await client.callTool({ name: "weather__get_forecast", arguments: { city: "paris" } });
      assert.ok(direct.isError);
      const viaHub = await client.callTool({
        name: "call_tool",
        arguments: { name: "weather__get_forecast", arguments: { city: "paris" } },
      });
      assert.strictEqual(JSON.parse((viaHub.content as TextContent[])[0].text).city, "paris");
      await client.close();
    });

    await test("call_tool and list_tools validate their arguments", async () => {
      const client = await connect(port, TOKEN_A);
      const noName = await client.callTool({ name: "call_tool", arguments: {} });
      assert.ok(noName.isError);
      const badArgs = await client.callTool({ name: "call_tool", arguments: { name: "x", arguments: [] } });
      assert.ok(badArgs.isError);
      const noArgs = await client.callTool({ name: "call_tool", arguments: { name: "weather__list_cities" } });
      assert.ok(!noArgs.isError);
      await client.close();
    });

    await test("two clients work concurrently on the same children", async () => {
      const [a, b] = await Promise.all([connect(port, TOKEN_A), connect(port, TOKEN_B)]);
      const calls = [a, b, a, b].map((c) => c.callTool({ name: "weather__list_cities", arguments: {} }));
      const results = await Promise.all(calls);
      assert.ok(results.every((r) => !r.isError));
      await Promise.all([a.close(), b.close()]);
    });

    await test("hub restart between two calls of the same client object still works", async () => {
      const client = await connect(port, TOKEN_A);
      const first = await client.callTool({ name: "weather__list_cities", arguments: {} });
      assert.ok(!first.isError);
      await stopHub(hub);
      hub = await startHub(configPath, port);
      const second = await client.callTool({ name: "weather__list_cities", arguments: {} });
      assert.ok(!second.isError);
      await client.close();
    });

    await test("a child killed after startup yields isError and the hub keeps serving", async () => {
      const client = await connect(port, TOKEN_A);
      const { pid } = await envReport(client);
      process.kill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
      const dead = await client.callTool({ name: "call_tool", arguments: { name: "envchild__env_report" } });
      assert.ok(dead.isError);
      assert.ok((dead.content as TextContent[])[0].text.length > 0);
      const alive = await client.callTool({ name: "weather__list_cities", arguments: {} });
      assert.ok(!alive.isError);
      await client.close();
    });
  } finally {
    await stopHub(hub);
    await unlink(configPath).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
