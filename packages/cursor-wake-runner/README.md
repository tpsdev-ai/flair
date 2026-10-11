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

A live run requires the Ed25519 key for `FLAIR_AGENT_ID`: the key is the signing identity and its feed is drained. Admin Basic credentials (`FLAIR_ADMIN_USER` / `FLAIR_ADMIN_PASSWORD`) with no key are accepted only for a read-only run (`--dry-run`) — a live receipt run needs the agent's signing key, because under Basic the server would stamp the written pointer with the Basic username while the row's `agentId` is `FLAIR_AGENT_ID`, so the receipt could not be verified on replay. The client refuses to send admin Basic credentials over plain HTTP to a non-loopback host. There is no `--participant` flag.

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
the runner ATTEMPTS one memory as its own agent: a stable id derived from the
OrgEvent id, content naming only the dispatch id and the Cursor agent id, and a
`hostSource` `{ host: "cursor", kind: "launch", id, url? }`. The ack follows a
successful write, OR an existing row at that id VERIFIED as this runner's own
receipt (same author, same deterministic content, same host-source identity); a
row that fails that check is not verified as this runner's receipt, reported as
`receiptMismatched` and left untouched (see **Not ours** below), and a receipt
the runner treats as a non-retryable refusal is acked without one (see
**Refused** below). The `id` is
the Cursor agent id: on create, the id Cursor returned (the requested id when the
response carries none); on a 409 replay, the requested id, which Cursor reported
as already in use. The `url` is set only on create, and only as Cursor returned
it. The write is private and omits `hostSourceScope`, so the server's read
projection keeps the pointer author-only (a non-author reading the memory sees
`hostSource: "withheld"`); only a live run signed with the agent's own key
writes the receipt. When the memory is selected for bootstrap, bootstrap prose
CITES the pointer (flair#2446) to a reader who may see it: this memory's author
sees the short `[via cursor/launch <id8> (unverified)]` citation — host/kind and
the first 8 id characters, display-only; the full url never appears there — and
a reader who may read the memory but not the pointer sees `[via withheld]`; an
admin bootstrap takes no pointer join. A `hostSource` is the writer's claim, not
verified host
authorship. A `hostSource` value the server's grammar would refuse (checked on
its NFC form, as the server checks it; the server stores that form) is omitted
with one line through the supplied `log` callback (the shipped CLI passes one),
and the receipt still lands if the remaining write succeeds.

A receipt already present under that id is left unchanged only when it VERIFIES
as this runner's own receipt (same author, content and host-source identity), so
a replay that reuses the agent (409) retries the receipt without rewriting the
stored one. The ack follows a successful write or a verified existing receipt —
except for a receipt the runner treats as a non-retryable refusal, which is acked
without one (see **Refused**) — and a failed write is classified:

- **Refused** — the runner treats a write Flair answered with 400, 409, 413 or
  422 as a non-retryable refusal. The event is acked anyway (the launch is
  real; the receipt is provenance, not control) and the cycle result's
  `receiptRefused` names the event, the HTTP status and the server's error code,
  when present — never the content — with one line through the supplied `log`
  callback; the exit status is unaffected.
- **Not ours** — a row already at the receipt id that is not verified as this
  runner's receipt: another agent's shared memory, or this agent's own row with
  different content, or a different host-source identity. The row is left
  untouched, the event is NOT acked, `receiptMismatched` names the id and the
  reason, and a one-shot run (`--once`) exits 2. A foreign PRIVATE row is not
  readable by the runner, so it reads as absent: the runner attempts the write
  and the server refuses that write instead.
- **Failed** — anything else: a network error or timeout, 401, 403, 408, 429,
  a 5xx, or a failed read. The event is not acked, `receiptFailed`
  is set, the next cycle retries the receipt, and a one-shot run (`--once`)
  exits 2 (a poller under `--interval` keeps polling).

Covered by `test/integration/host-source-cursor-launch-receipt-1940.test.ts`
(the runner cycle against a real Harper — it also pins that an unrelated memory at
the receipt id, and the runner's own row with different content, are a named
`receiptMismatched`, left untouched and not acked) and
`test/integration/cursor-wake-cli-launch-receipt-1940.test.ts` (the shipped CLI
through the real Flair client and a local Cursor fixture — drop the store and
it fails). `test/host-source-parity.test.ts` runs the runner's copy of the
grammar and the server's `validateHostSource` over the same inputs;
`test/serialize.test.ts` pins that `--interval` never overlaps its own cycles.

## Wake trigger

Pick one. All of them invoke this same process — that is what makes launch idempotent.

1. **Scheduled poll (recommended)** — cron, launchd, or systemd oneshot every minute (`--once`).
2. **Long-running poller** — `--interval 60` under a supervisor.
3. **Cursor Automation cron** — the automation's prompt must *run this CLI*, not "start a cloud agent on the latest issue". The automation is only the timer.

`GET /OrgEventCatchup/{agentId}` is the wake path. A2A `message/stream` SSE polls the same queue; the runner talks to catchup directly.

## Convention

See [`packages/cursor-flair/skills/coordinate`](../cursor-flair/skills/coordinate/SKILL.md): `coord.dispatch` to wake, watermark ack after handoff, optional `coord.ack` / `coord.done` status events. Heavy spec stays in GitHub.
