---
name: skill-creator
description: Create or update a skill for mcp-meta-hub. Use when the user wants to add a new skill, improve an existing SKILL.md, or connect a new MCP server to the hub.
---

# Skill Creator

Guide for creating skills that work with mcp-meta-hub.

## What is a Skill?

A skill = a SKILL.md file that tells the AI agent **which tools to use** and **when**. Most skills are pure documentation (Type 1). Only create a custom MCP server (Type 2) when no existing server fits.

## Step 1: Explore Available Tools

This is the primary use case for `list_tools` — discovering what's available to build a skill from:

```
list_tools({})                     → see all servers and tools
list_tools({ "prefix": "github" }) → see github tools with full schemas
```

Read the tool names, descriptions, and input schemas carefully. Pick the ones relevant to the skill you're building.

## Step 2: Write the SKILL.md

Create `skills/<name>/SKILL.md` with this structure:

```markdown
---
name: <skill-name>
description: <What it does>. Use when <trigger conditions>.
---

# <Skill Name>

<Brief context or domain knowledge>

## Key Tools

| Tool | Description |
|---|---|
| `<server>__<tool>` | What it does. Params: `param1` (type), `param2` (type). |

## Workflow

<Step-by-step instructions using call_tool directly>

## Examples

<Common calling patterns and edge cases>
```

## Rules

- **`description` is critical** — it's the trigger. Be specific: include what, when, and why.
- **List tools directly** with their key params. Once a skill is written, the agent should never need `list_tools` — it goes straight to `call_tool`.
- **One skill ≠ one server** — a skill can use tools from multiple servers, or expose a subset of one server's tools.
- **Include domain knowledge** — escalation rules, naming conventions, business logic. This is what makes skills powerful.

### Good vs Bad

```yaml
# ✅ Good — specific trigger, tools listed with params
description: Manage property rentals. Use when the user asks about tenants, rent, leases, or payments.

# ❌ Bad — vague, no trigger
description: Property utilities.
```

```markdown
# ✅ Good — tools listed directly with params
## Key Tools
| Tool | Description |
|---|---|
| `rentila__get_tenant` | Get tenant details. Params: `tenantId`. |
| `rentila__list_payments` | List rent payments. Params: `tenantId`, `status` (paid/pending). |

# ❌ Bad — tells agent to discover tools at runtime
## Usage
First call `list_tools("rentila")` to see available tools.
```

## Creating a Type 2 Skill (custom MCP server)

Only when you need to wrap a CLI, internal API, or build something that doesn't exist:

1. Create `skills/<name>/` with SKILL.md + MCP server code
2. Use `@modelcontextprotocol/sdk` to build the server
3. Register in `mcp-hub.json`

See `examples/weather/` for a complete working example.
