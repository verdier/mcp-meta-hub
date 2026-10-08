# mcp-meta-hub

**A lightweight MCP proxy that aggregates multiple MCP servers into two meta-tools.**

> Stop giving your AI agent a shell. Give it skills.

## The Problem

When you connect multiple MCP servers to an AI agent, every tool from every server lands in the LLM's context window. With 10 servers × 20 tools each, that's 200 tool descriptions competing for the model's attention. The result: bloated prompts, confused tool selection, higher costs, and hard limits from clients like Cursor (80 tools max).

## The Solution

**mcp-meta-hub** sits between your AI agent and your MCP servers. Instead of exposing all 200 tools, it exposes exactly **two**:

| Tool | Purpose |
|------|---------|
| `list_tools` | Explore available tools by prefix (used mainly by skill creators) |
| `call_tool` | Call any tool by its fully qualified name |

Skills (SKILL.md files) tell the agent exactly which tools to call — so in daily use, the agent goes straight to `call_tool`. `list_tools` is primarily used when **creating new skills**, to explore what's available.

```
AI Agent (Claude, Cursor, Copilot…)
    │
    │  sees 2 tools
    ▼
  mcp-meta-hub
    │
    │  connects to N servers
    ▼
  ┌─────────┬──────────┬───────────┐
  │ weather │ database │ github    │  ← MCP servers
  │ 3 tools │ 8 tools  │ 25 tools  │
  └─────────┴──────────┴───────────┘
```

## Quick Start

### Install

```bash
npm install -g mcp-meta-hub
```

### Configure

Create `mcp-hub.json`:

```json
{
  "servers": {
    "weather": {
      "command": "node",
      "args": ["./skills/weather/index.js"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

### Run

```bash
mcp-meta-hub ./mcp-hub.json
```

### Connect to your AI client

Add mcp-meta-hub to your client's MCP configuration. For example, in Claude Desktop:

```json
{
  "mcpServers": {
    "hub": {
      "command": "mcp-meta-hub",
      "args": ["./mcp-hub.json"]
    }
  }
}
```

That's it. Your agent now sees 2 tools instead of 200.

## How It Works

### The Two Loops

**Skill creation** (one-time): use `list_tools` to explore servers, then write a SKILL.md documenting the key tools and workflows.

**Daily usage** (99% of the time): the agent reads a SKILL.md and calls `call_tool` directly — no discovery needed.

```
┌─────────────────────────────────────────┐
│  Skill Creator (one-time)               │
│  list_tools("github") → write SKILL.md  │
└──────────────────┬──────────────────────┘
                   │ produces
                   ▼
              SKILL.md
                   │ read by
                   ▼
┌─────────────────────────────────────────┐
│  Agent (daily usage)                    │
│  read SKILL.md → call_tool() directly   │
└─────────────────────────────────────────┘
```

### Tool Naming Convention

Tools are namespaced as `{server}__{tool}`:

- `weather__get_forecast`
- `weather__list_cities`
- `github__create_issue`
- `github__list_repos`
- `database__query`

This prevents name collisions and makes prefix-based discovery natural.

## Configuration Reference

### Stdio Server (local process)

```json
{
  "servers": {
    "my-skill": {
      "command": "node",
      "args": ["./path/to/server.js"],
      "env": {
        "API_KEY": "secret"
      }
    }
  }
}
```

### SSE Server (remote)

```json
{
  "servers": {
    "remote-api": {
      "url": "http://localhost:3001/sse",
      "transport": "sse"
    }
  }
}
```

### Streamable HTTP Server (remote)

```json
{
  "servers": {
    "remote-api": {
      "url": "http://localhost:3001/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### Child environment (stdio servers)

A stdio child receives the hub's environment **minus every variable whose name matches `/KEY|TOKEN|SECRET|PASSWORD/i`**, plus the `env` declared for it. A declared value of the form `"$NAME"` is read from the hub's full environment, so a child that needs a secret must declare it:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" }
    }
  }
}
```

> **Breaking change in 0.2.0:** before, children inherited the whole hub environment. Children that relied on inherited secrets (`*_API_KEY`, `*_TOKEN`, ...) must now declare them in `env`.

### Always-listed tools (`always`)

By default an agent only sees `list_tools` and `call_tool`. For the few tools it uses constantly, `always` lists them directly in `tools/list`, under the same qualified name `call_tool` uses, with their original `inputSchema`, `outputSchema` and `annotations`. They stay callable through `call_tool` too.

```json
{
  "servers": {
    "weather": {
      "command": "node",
      "args": ["./skills/weather/dist/index.js"],
      "always": ["list_cities"]
    },
    "notes": { "command": "node", "args": ["./notes.js"], "always": true }
  }
}
```

`always: true` lists every tool of the server; an array selects tools by their **original** name (an unknown name logs a warning). If two tools end up with the same effective name, or one collides with `list_tools` / `call_tool`, the later tool is skipped with an error in the log.

## HTTP Mode

```bash
MCP_HUB_TOKEN_APP=... mcp-meta-hub ./mcp-hub.json --http 127.0.0.1:8080
```

Without `--http` the hub speaks stdio, as before. With it, the hub serves Streamable HTTP on `/mcp`:

- **Stateless**: no MCP session. Each POST gets a fresh server, so a client survives a hub restart. GET and DELETE answer `405`.
- **Loopback only**: `--http` accepts exactly `127.0.0.1`, `localhost` or `::1` (lowercase) and refuses anything else. For these hosts the hub rejects requests whose `Host` header is not loopback (DNS rebinding protection).
- **Bearer auth**: each client has its own token, read from an environment variable at startup. `clients` is required and non-empty in HTTP mode; a missing, empty or duplicated token stops the hub from starting.

```json
{
  "servers": { "weather": { "command": "node", "args": ["./weather.js"] } },
  "clients": {
    "app": { "tokenEnv": "MCP_HUB_TOKEN_APP" },
    "ci": { "tokenEnv": "MCP_HUB_TOKEN_CI" }
  }
}
```

A request without a valid `Authorization: Bearer <token>` gets `401` before anything is dispatched. Every tool call is logged on stderr with the client name, the tool, the outcome and the duration; headers and tokens are never logged.

On `SIGTERM`/`SIGINT` the hub stops accepting connections, stops its children, and exits (after 5 seconds at most).

All clients share the same children, started once.

## OAuth for HTTP children

A remote MCP server that requires OAuth (authorization code + PKCE, with dynamic client registration or a pre-registered client) can be a child: the hub obtains the grant once through a browser, stores it, and refreshes it on its own. MCP clients of the hub never see any OAuth.

```json
{
  "servers": {
    "docs": { "transport": "streamable-http", "url": "https://mcp.example.com/mcp", "oauth": true },
    "tasks": {
      "transport": "streamable-http",
      "url": "https://api.example.org/mcp",
      "oauth": { "scopes": ["read"], "allowedOrigins": ["https://auth.example.org"] }
    }
  },
  "clients": { "app": { "tokenEnv": "MCP_HUB_TOKEN_APP" } },
  "oauth": { "redirectUrl": "https://hub.example.net/oauth/callback" }
}
```

Global `oauth`:

- `redirectUrl` (required as soon as a child has `oauth`): the callback as **your browser** reaches the hub, always `<origin>/oauth/callback`. HTTPS, or plain HTTP on a loopback host. The hub listens on loopback only, so a reverse proxy on another host name must forward to it.
- `storeDir` (default `oauth`, relative to the config file): directory of the credential store.

Per child, `oauth` is `true` or an object (only on `streamable-http` children; elsewhere it is a config error):

| Option | Meaning |
|---|---|
| `scopes` | Scopes requested when the server's metadata advertises none. |
| `clientId` | Pre-registered public client. Without it the hub registers itself dynamically. |
| `clientName` | Client name sent at registration (default `mcp-meta-hub`). |
| `allowedOrigins` | Origins other than the endpoint's that this child's OAuth traffic may reach, typically a separate authorization server. Each entry is a bare origin (`https://auth.example.org`): a path, query, fragment or credentials is a config error. |
| `allowPrivateNetwork` | Allow private, loopback and link-local addresses, and plain HTTP to them only. For tests and servers on your own network. Off unless set. |

### Lifecycle

- **Protocol**: an OAuth child speaks through the MCP SDK's own HTTP transport and OAuth client: `401` and `WWW-Authenticate` handling (resource metadata URL and scope from the challenge), refresh, `403 insufficient_scope` step-up and the loop breakers are the SDK's, unchanged. The hub adds the credential store, the network guard and the queue below.
- **One operation at a time per OAuth child**: every tool call to the child, its (re)connection, an authorization start and a code exchange go through one serial queue, so a refresh a call triggers never overlaps anything else (servers that rotate refresh tokens would otherwise revoke the grant, and a stale refresh could overwrite a newer authorization). Calls to one OAuth child therefore do not run in parallel. An item leaves the queue when its work and every request it started have stopped. A timeout (30 s to connect or authorize, 60 s for a call) answers the caller and cancels the item: its requests are aborted, including those the SDK detaches, and nothing is stored on its behalf afterwards. Other children are unaffected.
- **No standalone stream**: the MCP endpoint's optional `GET` stream (server-initiated messages) is not opened for OAuth children, and an interrupted response stream is not resumed: its reconnections would authenticate outside the queue. The hub only calls tools and registers no sampling or elicitation handlers, so nothing is lost today. Responses streamed in answer to a call work normally.
- **Startup**: each OAuth child connects with its stored grant. Without one (or if the grant is rejected) the child is `needs-auth`: it has no tools, and the hub starts and serves the others anyway. A child never connected makes one unauthenticated request and, the first time, registers a client dynamically (the registration is stored and reused); likewise a server that rejects the client (`invalid_client`) is re-registered in the background, with no authorization published.
- **Refresh**: on a `401` the SDK refreshes the access token once and retries. A refresh response without a new refresh token keeps the previous one.
- **Rejected grant** (`invalid_grant`, `invalid_client`, a second `401` right after a refresh): the child becomes `needs-auth`, disappears from `tools/list` and `list_tools`, and a call to one of its tools returns an `isError` result: `Server "docs" needs authorization: open https://hub.example.net/`. A rejected client registration is dropped and replaced.
- **Outage** (network error, `5xx`, timeout): the call fails, the grant is kept, nobody is asked to log in again.
- **After an authorization**: only that child reconnects; its catalog entries (including `always`) are replaced in one step, the rules for collisions are unchanged, calls already running on the old connection finish before it is closed.

### Browser surface

With `--http` and a global `oauth`, the listener also serves three pages, **outside the bearer gate** and with their own `Host` allowlist (the host of `redirectUrl`, plus loopback; the header must be exactly `host` or `host:port`):

| Route | |
|---|---|
| `GET /` | Status page: each child's name, transport, state (`connected`, `needs-auth`, `failed`), tool count, and a **Connect** button for OAuth children. No secret. |
| `POST /oauth/start/<server>` | The Connect button. Refused unless the `Origin` header is exactly the origin of `redirectUrl`. Drops the child's tokens (and its client registration if it was made for another redirect URL), then redirects (`303`) to the provider. At most one authorization is pending per server: a newer start supersedes the older one. |
| `GET /oauth/callback` | Accepts `state` with `code` or `error` (plus `iss`, `scope`, `error_description`, `error_uri`, ignored), nothing else and nothing twice. The state is single use and expires after 10 minutes. It is consumed, its code exchanged with its own PKCE verifier, and the child reconnected as one item of the child's queue; the callback of a superseded start is refused ("superseded, start again") without reaching the token endpoint. Answers with a fixed page that never echoes a parameter. |

Every other path, `/mcp` included, behaves exactly as without OAuth: bearer first, loopback `Host` only on `/mcp`. Pages are sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and a CSP that forbids scripts and framing.

To authorize: open the status page through the `redirectUrl` origin, press Connect, log in at the provider. In stdio mode there is no browser surface; a grant obtained in HTTP mode is used and refreshed all the same.

### Credential store

One JSON file, `<storeDir>/credentials.json`: per child the endpoint it is bound to, the client registration, the tokens and the discovered metadata. The directory is `0700`, the file `0600`, written atomically (temporary file, fsync, rename), and a symlink or a corrupt file stops the hub instead of being overwritten. Tokens are stored in **plaintext**: protect the directory like any secret. Changing a child's `url` discards its record. PKCE verifiers and authorization states live in memory only. One hub process per store.

### Network guard

Everything an OAuth child sends (MCP requests, discovery, registration, token and refresh requests) and the authorization URL handed to the browser go through an outbound guard:

- HTTPS only, no credentials or fragment in the URL;
- origin of the child's `url` or one of its `allowedOrigins`, nothing else;
- public addresses only: the host is resolved once, every answer must be public, and the connection is pinned to the checked address (no DNS rebinding between check and connect);
- every redirect is checked again, at most 3, never for a non-idempotent request, and a cross-origin redirect keeps only `Accept` and `Content-Type`.

`allowPrivateNetwork` lifts the public-address rule for one child; plain HTTP stays refused towards a public address.

### Threat notes

- The status page and the Connect button are reachable without a bearer by anything that can reach the listener, including any local process. They expose server names and states only; a started authorization completes only after someone logs in at the provider in a browser.
- The `Origin` check on Connect blocks cross-site form posts. Put the browser surface behind your reverse proxy's own access control if it is reachable from a network.
- Logs and tool errors of OAuth children carry an error's class and HTTP status or JSON-RPC code, never its message: SDK and remote errors can embed a response body or reflect anything a server chose, and a body can echo a credential. The hub's own messages (network policy refusals, "needs authorization") are shown as written.
- The guard checks and pins the addresses of the hub's own requests. The authorization URL it hands to the browser is checked once (origin, address), but the browser resolves that host again by itself, which the hub cannot pin.
- Children without `oauth` keep their fixed `headers` and do not go through the network guard.

## Skills

A **skill** is a SKILL.md file that tells the AI agent what tools are available and when to use them.

**Skills are views over your tools, not 1:1 mappings to servers.** You can slice them however you want:

- **1 skill per server** — document all tools from a GitHub MCP → `github` skill
- **1 skill per use case** — cherry-pick tools across servers → `incident-response` skill uses GitHub + Sentry + PagerDuty
- **Partial coverage** — a server has 25 tools but you only need 3? Document just those 3. The rest stay discoverable via `list_tools` but the agent knows exactly which ones matter for this skill.
- **Multiple skills, same server** — a GitHub MCP can feed a `code-review` skill AND a `release-management` skill, each with different workflows and different subsets of tools.

Think of it like SQL views: same underlying tables, different perspectives for different purposes.

### The Skill Creator Pattern

The `skill-creator` is a special meta-skill: it's the **only skill that uses `list_tools`**. All other skills go straight to `call_tool`.

The workflow:
1. Agent receives "create a skill for X"
2. Skill-creator SKILL.md is activated
3. Agent calls `list_tools` to discover available tools and schemas
4. Agent writes a new SKILL.md with the right tools, params, and workflows
5. From now on, the new skill **never calls `list_tools`** — it goes direct

This is why mcp-meta-hub ships with a [`skill-creator` example](./examples/skill-creator/SKILL.md) — it's the bootstrap skill that creates all others.

There are two types of skills:

### Type 1: Documentation Skills (99% of cases)

You use existing MCP servers (from npm, the community, your team) and write a **SKILL.md** to give the agent context. **No code required.** Just markdown.

```
skills/devops/
└── SKILL.md       ← That's it. Zero code.
```

**Example:** Connect 3 existing MCP servers (GitHub, Sentry, PagerDuty) and let the [skill-creator](./examples/skill-creator/SKILL.md) build the skill that matches your exact workflow:

```markdown
---
name: incident-response
description: Handle production incidents. Use when the user reports a bug, outage, or needs to investigate an error in production.
---

# Incident Response

When an incident is reported:

1. Check recent errors → `call_tool("sentry__list_issues", { "status": "unresolved" })`
2. Find related PRs → `call_tool("github__search_commits", { "query": "fix OR hotfix", "since": "24h" })`
3. Page on-call if P0 → `call_tool("pagerduty__get_on_call", {})`

## Key Tools

| Tool | Description |
|---|---|
| `sentry__list_issues` | List errors. Params: `status` (unresolved/resolved), `sort` (date/freq). |
| `sentry__get_issue` | Get error details + stack trace. Params: `issueId`. |
| `github__search_commits` | Search recent commits. Params: `query`, `since`. |
| `github__create_issue` | Create tracking issue. Params: `repo`, `title`, `labels`. |
| `pagerduty__get_on_call` | Get current on-call engineer. |

## Escalation Rules

- P0 (site down): Page on-call immediately
- P1 (feature broken): Create GitHub issue, notify #incidents
- P2 (degraded): Create GitHub issue, triage next standup
```

The skill doesn't implement anything — it **orchestrates existing tools** with domain knowledge. The agent reads this and knows exactly which tools to call, with which parameters, in which order.

This is the power: **your expertise becomes a reusable skill file.**

### Type 2: Custom MCP Servers (when no existing server fits)

When you need to wrap a CLI, an internal API, or build something custom, create an MCP server and register it in `mcp-hub.json`:

```
skills/weather/
├── SKILL.md          ← Describes the skill for the AI agent
├── src/index.ts      ← MCP server (use @modelcontextprotocol/sdk)
└── package.json
```

```json
{
  "servers": {
    "weather": {
      "command": "node",
      "args": ["./skills/weather/dist/index.js"]
    }
  }
}
```

See [`examples/weather/`](./examples/weather/) for a complete working example with SKILL.md + MCP server code.

### Multi-Instance Skills

The same MCP server can run multiple times with different configs — useful for multi-account scenarios:

```json
{
  "servers": {
    "accounting-company-a": {
      "command": "node",
      "args": ["./skills/accounting/dist/index.js"],
      "env": { "API_KEY": "key-for-company-a" }
    },
    "accounting-company-b": {
      "command": "node",
      "args": ["./skills/accounting/dist/index.js"],
      "env": { "API_KEY": "key-for-company-b" }
    }
  }
}
```

Tools become `accounting-company-a__get_balance` and `accounting-company-b__get_balance` — same skill, isolated contexts.

## Advanced Configuration

### Environment Variable References

Use `$VAR` in server env values to reference variables from the parent process environment. Useful for multi-instance setups where the same server needs different credentials:

```json
{
  "servers": {
    "accounting-a": {
      "command": "node",
      "args": ["./accounting-server.js"],
      "env": { "DB_PASSWORD": "$ACCT_A_PASSWORD" }
    },
    "accounting-b": {
      "command": "node",
      "args": ["./accounting-server.js"],
      "env": { "DB_PASSWORD": "$ACCT_B_PASSWORD" }
    }
  }
}
```

The hub resolves `$ACCT_A_PASSWORD` from `process.env` at startup. If a referenced variable is not found, a warning is logged and the literal `$VAR` string is kept. Stdio servers also inherit the hub's environment, except variables whose name matches `/KEY|TOKEN|SECRET|PASSWORD/i` (see [Child environment](#child-environment-stdio-servers)); declare the secrets a child needs in its `env`.

### Tool Prefix

By default, tools are namespaced as `{server}__{tool}` to prevent collisions. You can override this **per server**:

```json
{
  "servers": {
    "weather": {
      "command": "node",
      "args": ["./weather.js"],
      "prefix": true
    },
    "brave": {
      "command": "npx",
      "args": ["brave-search"],
      "prefix": false
    },
    "internal": {
      "command": "node",
      "args": ["./internal.js"],
      "prefix": "myapp__"
    }
  }
}
```

| Value | Example tool name | Use case |
|-------|-------------------|----------|
| `true` (default) | `weather__get_forecast` | Multiple servers, prevent collisions |
| `false` | `get_forecast` | Server already prefixes its own tool names |
| `"myapp__"` | `myapp__get_forecast` | Custom prefix for branding/grouping |

## Why Not Just Use Bash?

The current trend is giving AI agents shell access. It's powerful but dangerous:

| | Bash | mcp-meta-hub |
|---|------|---------|
| **Scope** | Unlimited system access | Only defined tools |
| **Safety** | `rm -rf /` is one hallucination away | Agent can only call registered tools |
| **Auditability** | Arbitrary commands | Structured tool calls |
| **Reliability** | Depends on shell parsing | Typed schemas with validation |

mcp-meta-hub enforces the **principle of least privilege**: the agent can only do what your skills explicitly allow.

## Comparison with Existing Solutions

| | mcp-meta-hub | MetaMCP | 1MCP | combine-mcp |
|---|---------|---------|------|-------------|
| **Meta-tools** | ✅ `list_tools` + `call_tool` | ❌ | ❌ | ❌ |
| **Lazy discovery** | ✅ On-demand | ❌ All upfront | ❌ All upfront | ❌ All upfront |
| **Footprint** | 1 process, 1 JSON file | Docker + Postgres + UI | npm package | Go binary |
| **Setup** | 30 seconds | Minutes | Minutes | Minutes |
| **Dependencies** | MCP SDK only | Full stack | Multiple | None |

The key difference: other proxies aggregate tools and dump them all into the LLM context. **mcp-meta-hub makes them discoverable on demand.** This is the difference between loading every page of a website at once vs. having a search bar.

## Development

```bash
git clone https://github.com/verdier/mcp-meta-hub.git
cd mcp-meta-hub
npm install
npm run build

# Build the example skill
cd examples/weather && npm install && npm run build && cd ../..

# Run tests
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
