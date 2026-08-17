---
name: health
description: Diagnose a failing Flair connection. Use when bootstrap or any flair tool errors, or the user asks if Flair is up. There is no Health MCP tool — probe with bootstrap. Report FLAIR_URL and FLAIR_AGENT_ID, never secrets.
---

# Health

Probe the configured Flair instance. There is no `Health` MCP tool on `flair-mcp`.

## When to use

- Any `flair` tool returns `connection_error`, `auth_error`, or "FLAIR_AGENT_ID is required"
- The user asks "is Flair up?" / "why can't you remember?"
- After a URL or agent-id change

## Steps

1. Report the **configured** `FLAIR_URL` and `FLAIR_AGENT_ID` (from plugin config / env). Never print key material, `FLAIR_ADMIN_PASSWORD`, or file contents.
2. Call `bootstrap` with `channel`: `"cursor"` and a short `currentTask` like `"health check"`.
   - Success means MCP + auth + daemon are all working.
3. Optionally prove write/read: `memory_store` an ephemeral probe (`type`: `session`, `durability`: `ephemeral`, content like `"flair health probe"`), then `memory_get`, then `memory_delete` that id. Skip if the user did not ask for a write test.
4. Map the failure:

| Signal | Likely cause | What to tell the user |
|---|---|---|
| `connection_error` | Nothing listening at `FLAIR_URL` | The default `http://127.0.0.1:19926` is the **npx host**, not "the user's laptop" as seen from a cloud VM. Grok Bot / Cursor cloud agents cannot reach a laptop localhost. Set `FLAIR_URL` to a hosted, Fabric, Tailscale, or tunneled origin the agent machine can open. Local Cursor: run `flair status` / `flair start` on that same machine. |
| `auth_error` | Key or agent mismatch | The Ed25519 key on the **npx host** must match `flair agent add <id>`. Restart the MCP host after a daemon restart. |
| `FLAIR_AGENT_ID is required` | Plugin variable unset | **Plugins → Configure** and set `FLAIR_AGENT_ID` to the same id used with `flair agent add`. |
| timeout | Slow embed / dead daemon | Retry once; if it persists, check the Flair process on the URL host. |

5. Do **not** tell the user to `curl` a private IP or `127.0.0.1` unless that address is on the machine they are sitting at (or the machine that actually runs Flair). Cloud-agent localhost is the agent VM.

## Do not

- Dump secrets or key paths into chat
- Claim a hosted Flair cloud product exists
- Recommend the Claude-only `flair-session-start` hook
