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
  │ weather │ database │ github    │  ← MCP servers ("skills")
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

## Skills

A **skill** is a SKILL.md file that tells the AI agent what tools are available and when to use them.

**Skills are views over your tools, not 1:1 mappings to servers.** You can slice them however you want:

- **1 skill per server** — document all tools from a GitHub MCP → `github` skill
- **1 skill per use case** — cherry-pick tools across servers → `incident-response` skill uses GitHub + Sentry + PagerDuty
- **Partial coverage** — a server has 25 tools but you only need 3? Document just those 3. The rest stay discoverable via `list_tools` but the agent knows exactly which ones matter for this skill.
- **Multiple skills, same server** — a GitHub MCP can feed a `code-review` skill AND a `release-management` skill, each with different workflows and different subsets of tools.

Think of it like SQL views: same underlying tables, different perspectives for different purposes.

There are two types:

### Type 1: Documentation Skills (99% of cases)

You use existing MCP servers (from npm, the community, your team) and write a **SKILL.md** to give the agent context. **No code required.** Just markdown.

```
skills/devops/
└── SKILL.md       ← That's it. Zero code.
```

**Example:** You connect 3 existing MCP servers (GitHub, Sentry, PagerDuty) and write one skill that teaches the agent your incident response workflow:

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

When you need to wrap a CLI, an internal API, or build something custom, you create an MCP server:

```
skills/weather/
├── SKILL.md          ← Describes the skill for the AI agent
├── src/
│   └── index.ts      ← MCP server implementation
├── package.json
└── tsconfig.json
```

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "weather", version: "1.0.0" });

server.tool(
  "get_forecast",
  "Get weather forecast for a city",
  { city: z.string().describe("City name") },
  async ({ city }) => ({
    content: [{
      type: "text",
      text: JSON.stringify({ city, temperature_celsius: 22, condition: "sunny", humidity_percent: 55 }),
    }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Register it in `mcp-hub.json` alongside your other servers:

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

See [`examples/weather/`](./examples/weather/) for a complete working example.

### SKILL.md Format

Every skill has a SKILL.md with YAML frontmatter:

```markdown
---
name: my-skill
description: What it does + when to use it. This is how the agent finds your skill.
---

# Skill Name

[Context, domain knowledge, workflows]

## Key Tools

| Tool | Description |
|---|---|
| `prefix__tool_name` | What it does. Params: `param1` (type), `param2` (type). |

## Examples

[Calling patterns, common workflows, edge cases]
```

**The `description` is the most important line.** It's what the LLM matches against the user's request:

```yaml
# ✅ Good — specific, includes trigger conditions
description: Manage property rentals (tenants, leases, payments). Use when the user asks about tenants, rent, or properties.

# ❌ Bad — vague, no trigger
description: Property management utilities.
```

**Skills list tools directly** — the agent should know which tools to call without introspection. `list_tools` is for advanced use and discovery, not a prerequisite.

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

See [`examples/weather/`](./examples/weather/) for a complete working skill with SKILL.md.

## Why Not Just Use Bash?

The current trend is giving AI agents shell access. It's powerful but dangerous:

| | Bash | mcp-meta-hub |
|---|------|---------|
| **Scope** | Unlimited system access | Only defined tools |
| **Safety** | `rm -rf /` is one hallucination away | Agent can only call registered skills |
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
