# cursor-wake-runner

Cursor-side consume + wake half of [flair#1583](https://github.com/tpsdev-ai/flair/issues/1583) / [flair#1613](https://github.com/tpsdev-ai/flair/issues/1613).

Flair cannot wake a dormant Cursor agent (`pushNotifications: false`; no session-start hook). This runner **is** the trigger: it drains **this** agent's `OrgEventCatchup` feed and launches one [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent/api/endpoints) per directed `coord.dispatch` or `a2a.message`.

A running agent uses `flair_catchup` instead (#1612). Do not rebuild a message board; do not use shared memory as a queue.

## Single-launch

OrgEvent delivery is at-least-once. The runner maps each event id to one client-supplied Cursor `agentId` (`bc-<sha256 uuid>`). Re-POSTing that id returns `409 agent_id_conflict` and is treated as already-handed-off, then acked. Redelivery cannot start a second agent. A launch failure does **not** advance the watermark.

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

With an Ed25519 key, `FLAIR_AGENT_ID` is the signing identity and the feed requested by the runner. With admin Basic credentials and no key, the admin credential authenticates the request and `FLAIR_AGENT_ID` selects the feed. The client refuses to send admin Basic credentials over plain HTTP to a non-loopback host. There is no `--participant` flag.

| Variable | Required | Notes |
|---|---|---|
| `FLAIR_AGENT_ID` | yes | The feed to drain; with a key, also the signing identity |
| `FLAIR_URL` | no | Default `http://localhost:19926` |
| `FLAIR_KEY_PATH` | no | Default `~/.flair/keys/<id>.key` |
| `CURSOR_API_KEY` | yes (unless `--dry-run`) | [Dashboard → API Keys](https://cursor.com/dashboard/api) |
| `CURSOR_API_BASE` | no | Default `https://api.cursor.com` |
| `CURSOR_REPO_URL` | no | Else parsed from the event's GitHub pointer |
| `CURSOR_STARTING_REF` | no | Branch or SHA |
| `CURSOR_ENV_NAME` | no | Named Cursor environment (exclusive with repo) |
| `CURSOR_AUTO_CREATE_PR` | no | `true` to open a PR when the run completes |

## Launch receipt

After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
the runner records ONE memory as its own agent: a stable id derived from the
OrgEvent id, content naming only the dispatch id and the Cursor agent id, and a
`hostSource` `{ host: "cursor", kind: "launch", id, url? }`. The `id` is the
Cursor agent id: on create, the id Cursor returned (the requested id when the
response carries none); on a 409 replay, the requested id, which Cursor
reported as already in use. The `url` is set only on create, and only as Cursor
returned it. A `hostSource` value the server's grammar would refuse (checked on
its NFC form, as the server checks it; the server stores that form) is omitted
with one log line, and the receipt still lands. `hostSource` is the writer's claim, not verified host
authorship.

A receipt already present under that id is left unchanged, so a replay that
reuses the agent (409) retries the receipt without rewriting the stored one.
The write precedes the watermark ack, and a failed write is classified:

- **Refused** — Flair answered the write with 400, 409, 413 or 422, a request
  it will refuse again. The event is acked anyway (the launch is real; the
  receipt is provenance, not control) and the cycle result's `receiptRefused`
  names the event, the HTTP status and the server's error code — never the
  content — with one log line; the exit status is unaffected. Retrying would
  refuse every replay the same way and hold every later dispatch for this
  agent.
- **Failed** — anything else: a network error or timeout, 401, 403, 408, 429,
  a 5xx, or a failed existence read. The event is not acked, `receiptFailed`
  is set, the CLI exits 2, and the next cycle retries the receipt.

Covered by `test/integration/host-source-cursor-launch-receipt-1940.test.ts`;
`test/host-source-parity.test.ts` runs the runner's copy of the grammar and the
server's `validateHostSource` over the same inputs.

## Wake trigger

Pick one. All of them invoke this same process — that is what makes launch idempotent.

1. **Scheduled poll (recommended)** — cron, launchd, or systemd oneshot every minute (`--once`).
2. **Long-running poller** — `--interval 60` under a supervisor.
3. **Cursor Automation cron** — the automation's prompt must *run this CLI*, not "start a cloud agent on the latest issue". The automation is only the timer.

`GET /OrgEventCatchup/{agentId}` is the wake path. A2A `message/stream` SSE polls the same queue; the runner talks to catchup directly.

## Convention

See [`packages/cursor-flair/skills/coordinate`](../cursor-flair/skills/coordinate/SKILL.md): `coord.dispatch` to wake, watermark ack after handoff, optional `coord.ack` / `coord.done` status events. Heavy spec stays in GitHub.
