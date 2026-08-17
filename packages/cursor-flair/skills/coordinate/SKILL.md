---
name: coordinate
description: Publish workspace state or org events (claim/release/status) via flair_workspace_set and flair_orgevent. Use for multi-agent branch/phase/task coordination. Skip for solo local memory. Never impersonate another agent.
---

# Coordinate

Office-space style coordination. Identity comes from the signed key, not the request body.

## When to use

- Several agents share one Flair instance and need to claim a branch, phase, or task
- "I'm on `feat/auth`, implementing" / "releasing this task"

**Skip** for solo local memory. Do not spam workspace rows on a single-laptop setup.

## Tools

- `flair_workspace_set` — your current ref/branch, phase, and task
- `flair_orgevent` — claim / release / status events

The server attributes `agentId` / `authorId` from the Ed25519 signature. You can only write as yourself.

## Steps

### Workspace state

Call `flair_workspace_set` with:

- `ref` — branch, worktree, or task ref (required)
- `label` — human-readable name
- `provider` — `"cursor"` is appropriate here (tool default is `"mcp"`)
- `task` — issue / task id
- `phase` — e.g. `design`, `implement`, `review`
- `summary` — one line of current state

### Org event

Call `flair_orgevent` with:

- `kind` — e.g. `coord.claim`, `coord.release`, `status`
- `summary` — short
- `detail`, `scope`, `targets` (agent ids) as needed

## Do not

- Put another agent's id in the body to impersonate them — the server ignores it and signs as you
- Claim work you are not doing
- Use this as a substitute for `memory_store`
