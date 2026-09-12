# cursor-wake-runner

Cursor-side consume + wake half of [flair#1583](https://github.com/tpsdev-ai/flair/issues/1583) / [flair#1613](https://github.com/tpsdev-ai/flair/issues/1613).

Flair cannot wake a dormant Cursor agent (`pushNotifications: false`; no session-start hook). This runner **is** the trigger: it drains **this** agent's `OrgEventCatchup` feed and launches one [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent/api/endpoints) per directed `coord.dispatch` or `a2a.message`.

A running agent uses `flair_catchup` instead (#1612). Do not rebuild a message board; do not use shared memory as a queue.

## Single-launch

OrgEvent delivery is at-least-once. The runner maps each event id to one client-supplied Cursor `agentId` (`bc-<uuid v5>`). Re-POSTing that id returns `409 agent_id_conflict` and is treated as already-handed-off, then acked. Redelivery cannot start a second agent. A launch failure does **not** advance the watermark.

If you point a Cursor Automation at "start a crew agent on the latest dispatch" *without* this runner, Cursor will mint a new agent every tick. That path is **not** safe. Schedule **this process**.

## Run

```bash
# one drain (cron / systemd / launchd)
FLAIR_AGENT_ID=anvil CURSOR_API_KEY=… \
  bun packages/cursor-wake-runner/src/cli.ts --once

# long-running poller
FLAIR_AGENT_ID=anvil CURSOR_API_KEY=… \
  bun packages/cursor-wake-runner/src/cli.ts --interval 60

# classify only — no Cursor create, no ack
FLAIR_AGENT_ID=anvil bun packages/cursor-wake-runner/src/cli.ts --once --dry-run
```

Identity is the signed `FLAIR_AGENT_ID`. There is no `--participant` flag and no way to name another agent's feed.

| Variable | Required | Notes |
|---|---|---|
| `FLAIR_AGENT_ID` | yes | Own feed only |
| `FLAIR_URL` | no | Default `http://localhost:19926` |
| `FLAIR_KEY_PATH` | no | Default `~/.flair/keys/<id>.key` |
| `CURSOR_API_KEY` | yes (unless `--dry-run`) | [Dashboard → API Keys](https://cursor.com/dashboard/api) |
| `CURSOR_API_BASE` | no | Default `https://api.cursor.com` |
| `CURSOR_REPO_URL` | no | Else parsed from the event's GitHub pointer |
| `CURSOR_STARTING_REF` | no | Branch or SHA |
| `CURSOR_ENV_NAME` | no | Named Cursor environment (exclusive with repo) |
| `CURSOR_AUTO_CREATE_PR` | no | `true` to open a PR when the run completes |

## Wake trigger

Pick one. All of them invoke this same process — that is what makes launch idempotent.

1. **Scheduled poll (recommended)** — cron, launchd, or systemd oneshot every minute (`--once`).
2. **Long-running poller** — `--interval 60` under a supervisor.
3. **Cursor Automation cron** — the automation's prompt must *run this CLI*, not "start a cloud agent on the latest issue". The automation is only the timer.

`GET /OrgEventCatchup/{agentId}` is the wake path. A2A `message/stream` SSE polls the same queue; the runner talks to catchup directly.

## Convention

See [`packages/cursor-flair/skills/coordinate`](../cursor-flair/skills/coordinate/SKILL.md): `coord.dispatch` to wake, watermark ack after handoff, optional `coord.ack` / `coord.done` status events. Heavy spec stays in GitHub.
