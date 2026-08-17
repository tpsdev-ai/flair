---
name: bootstrap
description: Load soul plus relevant memories at session start, resume, or when the user asks who you are / what you remember. Use before answering from memory after a long gap. Wraps the `bootstrap` MCP tool. Do not write on bootstrap.
---

# Bootstrap

Cold-start identity and memory. Read-only.

## When to use

- Session start, resume, or compact
- "Who am I?" / "What do we remember?"
- After a long gap, before answering from memory

Do **not** use this to store, update, or delete anything. If tools fail, switch to the health skill.

## Steps

1. Call the `bootstrap` tool on the `flair` MCP server. Pass:
   - `channel`: `"cursor"` (literal)
   - `currentTask`: a short phrase from the user's latest message
   - `subjects`: repo / folder / project names in scope (e.g. `["flair", "auth"]`)
   - `maxTokens`: leave the default (4000) unless the user asked for a tighter budget
2. Summarize what came back: soul (role, standards, project) plus a handful of relevant memories. Do **not** dump the raw payload.
3. If the call fails, stop guessing from memory and use the health skill. Ask for a reachable `FLAIR_URL`.
4. Do **not** write memories, soul, or relationships as a side effect of bootstrap.
5. Do **not** shell `flair-session-start`. That bin is a Claude Code SessionStart hook and is not part of this plugin.

## After bootstrap

Answer the user's question with the summarized context. If they switched tasks, follow with the context-loader skill instead of calling bootstrap again.
