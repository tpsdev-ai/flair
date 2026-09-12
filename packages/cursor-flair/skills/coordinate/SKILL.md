---
name: coordinate
description: Publish workspace state or org events (claim/release/status/dispatch) via flair_workspace_set and flair_orgevent. Drain your own feed with flair_catchup. Use for multi-agent branch/phase/task coordination and crew dispatch. Skip for solo local memory. Never impersonate another agent. Never read another agent's catchup.
---

# Coordinate

Office-space style coordination. Identity comes from the signed key, not the request body.

## When to use

- Several agents share one Flair instance and need to claim a branch, phase, or task
- "I'm on `feat/auth`, implementing" / "releasing this task"
- Dispatching work to a crew agent (`coord.dispatch`) or reporting that you started / finished it

**Skip** for solo local memory. Do not spam workspace rows on a single-laptop setup.

## Tools

- `flair_workspace_set` — your current ref/branch, phase, and task
- `flair_orgevent` — claim / release / status / dispatch events
- `flair_catchup` — drain **your own** OrgEvent feed (running agent only)

The server attributes `agentId` / `authorId` from the Ed25519 signature. You can only write as yourself. `flair_catchup` has no `agentId` / `participantId` argument — you cannot name another feed.

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

- `kind` — see vocabulary below
- `summary` — short (one line)
- `detail`, `scope`, `targets` (agent ids) as needed

Keep the payload light. Put the GitHub issue/PR URL or Beads id in `detail` (or `refId` if you are writing HTTP). The heavy spec stays in GitHub.

## Vocabulary

| kind | Who | Meaning |
|---|---|---|
| `coord.claim` | anyone | I am taking this ref / task |
| `coord.release` | anyone | I am no longer on it |
| `status` | anyone | Ambient progress |
| `coord.dispatch` | dispatcher (e.g. Flint) | Do this work. `targets` = the crew agent id. `detail` = pointer + one-line brief |
| `coord.ack` | crew | I received / started it (optional status back to the dispatcher) |
| `coord.building` | crew | In progress |
| `coord.done` | crew | Finished; pointer is the PR |
| `coord.blocked` | crew | Cannot finish; one-line why |
| `a2a.message` | A2A `message/send` | Same directed shape; the wake-runner treats it like `coord.dispatch` |

`coord.dispatch` / `a2a.message` are **directed**. Set `targets` to the crew agent. A broadcast dispatch is not a wake.

## Running agent — `flair_catchup`

If you are already running, drain your own feed:

1. `flair_catchup` (no args) — events after your watermark
2. Handle them
3. `flair_catchup` with `ack` = the page's `nextAfter` once processed

At-least-once: you may see an event twice. Do not treat a redelivery as new work.

**If the wake-runner is deployed** (the `#1613` poller), do **not** ack a `coord.dispatch` / `a2a.message` yourself and do **not** start that work in this session. Leave those events for the runner — it launches a Cursor Cloud Agent with an idempotent `agentId` and then acks. Acking first drops the wake. Starting the work yourself **and** leaving the event un-acked double-dispatches.

**If the wake-runner is not deployed** and you are the crew: do the referenced work (or hand it off), then ack.

## Dormant agent — wake-runner

Nothing in Flair wakes a stopped Cursor agent. The runner is the trigger:

```bash
FLAIR_AGENT_ID=<crew> CURSOR_API_KEY=… \
  bun packages/cursor-wake-runner/src/cli.ts --once
```

Schedule that command (cron / systemd / launchd) or `--interval 60`. A Cursor Automation may invoke **this CLI** on a cron; it must not "start a cloud agent on the latest dispatch" by itself (that mint is not idempotent).

The runner:

1. `GET /OrgEventCatchup/{self}` — owner-scoped
2. For each directed `coord.dispatch` / `a2a.message`, `POST https://api.cursor.com/v1/agents` with `agentId` = `bc-<uuid v5 of the OrgEvent id>`
3. `POST /OrgEventCatchup/{self}` `{ position }` after handoff
4. A `409 agent_id_conflict` is "already launched" — ack, do not create another

See [`packages/cursor-wake-runner/README.md`](../../../cursor-wake-runner/README.md).

## Do not

- Put another agent's id in the body to impersonate them — the server ignores it and signs as you
- Pass an `agentId` / `participantId` to `flair_catchup` hoping to read someone else's feed — the tool has no such argument
- Claim work you are not doing
- Use this as a substitute for `memory_store`
- Rebuild a message board or use shared memory as a queue
- Act on a stale / already-acked / already-launched dispatch
