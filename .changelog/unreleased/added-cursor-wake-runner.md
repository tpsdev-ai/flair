- **A Cursor-side wake-runner drains directed OrgEvents and launches one Cloud Agent per dispatch.**
  `packages/cursor-wake-runner` is the #1583 consume + wake half (flair#1613). It
  pages `GET /OrgEventCatchup/{self}` — owner-scoped, never another agent's
  feed — and for each directed `coord.dispatch` / `a2a.message` calls Cursor
  `POST /v1/agents` with a client-supplied `agentId` derived from the OrgEvent
  id (`bc-<sha256 uuid>`). Re-POST is `409 agent_id_conflict` and is treated as
  already-handed-off, then the watermark acks. Redelivery cannot start a second
  agent. A failed launch does not advance the cursor.

  The runner **is** the wake trigger (cron / `--interval` / a Cursor Automation
  that shells this CLI). Flair cannot wake a dormant Cursor agent. The
  `coordinate` skill documents `coord.dispatch` / `coord.ack`.

  > **Heads-up:** schedule this process. A Cursor Automation that starts a
  > crew agent *without* the runner's deterministic `agentId` can double-launch
  > on at-least-once redelivery.
