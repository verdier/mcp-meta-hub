---
name: incident-response
description: Handle production incidents end-to-end. Use when the user reports a bug, outage, service degradation, or needs to investigate an error in production.
---

# Incident Response

Workflow for handling production incidents using GitHub, Sentry, and PagerDuty.

## Key Tools

| Tool | Description |
|---|---|
| `sentry__list_issues` | List errors. Params: `status` (unresolved/resolved), `sort` (date/freq). |
| `sentry__get_issue` | Get error details + stack trace. Params: `issueId`. |
| `github__search_commits` | Search recent commits. Params: `query`, `since`. |
| `github__create_issue` | Create tracking issue. Params: `repo`, `title`, `labels`. |
| `pagerduty__get_on_call` | Get current on-call engineer. |

## Workflow

### 1. Assess

```
call_tool("sentry__list_issues", { "status": "unresolved", "sort": "date" })
```

Check for related recent deployments:

```
call_tool("github__search_commits", { "query": "deploy OR release", "since": "24h" })
```

### 2. Communicate

Find who's on call:

```
call_tool("pagerduty__get_on_call", {})
```

### 3. Fix

Create a tracking issue:

```
call_tool("github__create_issue", {
  "repo": "myorg/api",
  "title": "[P0] Service outage — <summary>",
  "labels": ["incident", "P0"]
})
```

### 4. Resolve

Link the Sentry issue to the fix PR:

```
call_tool("sentry__update_issue", { "issueId": "...", "status": "resolved" })
```

## Severity Levels

| Level | Criteria | Action |
|---|---|---|
| P0 | Site down | Page on-call immediately |
| P1 | Feature broken | Create issue, notify #incidents |
| P2 | Degraded perf | Create issue, triage next standup |
