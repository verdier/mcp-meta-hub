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
