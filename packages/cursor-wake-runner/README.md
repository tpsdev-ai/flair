# cursor-wake-runner

Cursor-side consume + wake half of [flair#1583](https://github.com/tpsdev-ai/flair/issues/1583) / [flair#1613](https://github.com/tpsdev-ai/flair/issues/1613).

Flair cannot wake a dormant Cursor agent (`pushNotifications: false`; no session-start hook). This runner **is** the trigger: it drains **this** agent's `OrgEventCatchup` feed and launches one [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent/api/endpoints) per directed `coord.dispatch` or `a2a.message`.

A running agent uses `flair_catchup` instead (#1612). Do not rebuild a message board; do not use shared memory as a queue.

## Single-launch

OrgEvent delivery is at-least-once. The runner maps each event id to one client-supplied Cursor `agentId` (`bc-<sha256 uuid>`). Re-POSTing that id returns `409 agent_id_conflict` and is treated as already handed off; ack still depends on the receipt outcome. Redelivery cannot start a second agent. A launch failure leaves that event unacked; earlier successful or skipped events
may still be acked.

If you point a Cursor Automation at "start a crew agent on the latest dispatch" *without* this runner, Cursor will mint a new agent every tick. That path is **not** safe. Schedule **this process**.

## Run

```bash
# one drain (cron / systemd / launchd)
FLAIR_AGENT_ID=anvil CURSOR_API_KEY=… \
  bun packages/cursor-wake-runner/src/cli.ts --once

# long-running poller
FLAIR_AGENT_ID=anvil CURSOR_API_KEY=… \
  bun packages/cursor-wake-runner/src/cli.ts --interval 60

# classify only — no Cursor create, no receipt write, no ack
FLAIR_AGENT_ID=anvil bun packages/cursor-wake-runner/src/cli.ts --once --dry-run
```

A live cycle loads and validates the Ed25519 key for `FLAIR_AGENT_ID` before
reading the feed, launching Cursor or writing a receipt. Every FlairClient
request uses that cached key, with no admin Basic fallback. A key missing before
loading, unparsable or not Ed25519 is refused by name; removing its file after
loading does not stop signed requests. The receipt store also requires signing.
The catchup reader and receipt store use the same Flair client and agent id.
Cursor launches use Cursor API Basic authentication with `CURSOR_API_KEY`.

Admin Basic credentials (`FLAIR_ADMIN_USER` / `FLAIR_ADMIN_PASSWORD`) are accepted
only for `--dry-run`: no Cursor create, receipt write or ack. Its catchup read may
create an `AgentReadPosition`. The runner selects the Cursor client from the mode
and Cursor config; its dry-run client never calls Cursor. The Flair client refuses
admin Basic over plain HTTP to a non-loopback host. There is no `--participant` flag.

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
`sourced` receipt (a `hostSource` `{ host: "cursor", kind: "launch", id, url? }`)
only when a pointer was STORED — an id the server's grammar refuses stores the
receipt WITHOUT a pointer if the remaining write succeeds, so it is unsourced
and gets no host-source citation. The ack follows a
successful write, OR an existing row at that id VERIFIED as this runner's own
receipt (same author, same deterministic content, same host-source identity); a
row that fails that check is not verified as this runner's receipt, reported as
`receiptMismatched` and left untouched (see **Not verified as this receipt** below), and a receipt
the runner treats as a non-retryable refusal is acked without one (see
**Refused** below). The `id` is
the Cursor agent id: on create, the id Cursor returned (the requested id when the
response carries none); on a 409 replay, the requested id, which Cursor reported
as already in use. The `url` is written only on create, and only as Cursor
returned it (an `already` result that carries a url never writes one, so a
serialized replay that reads the existing receipt cannot rewrite the create's
stored url — the two-runner race is disclosed, not claimed away). Neither is
derived from the dispatch
text. The write is private and omits `hostSourceScope`, so the server's read
projection keeps the pointer author-only. An ordinary non-author cannot read this
private row at all — it answers 404 to them — so they never see the pointer; an
admin CAN read the row, but an admin bootstrap takes no pointer join. `withheld`
applies only to a non-author who can read the row after its visibility changes
(for instance it is later shared): they read the record but not the pointer, and
see `hostSource: "withheld"`. Only a live run signed with the agent's own key
writes the receipt. When a pointer was stored AND the memory is selected for
bootstrap, bootstrap prose CITES that pointer (flair#2446) to a reader who may see
it: this memory's author
sees the short `[via cursor/launch <id8> (unverified)]` citation — host/kind and
the first 8 id characters, display-only; the full url never appears there — and
a reader who may read the memory but not the pointer sees `[via withheld]`; an
admin bootstrap takes no pointer join. A memory with no pointer — a receipt whose
Cursor id the grammar refused stores none — gets no host-source citation. A `hostSource` is the
writer's claim, not
verified host
authorship. A `hostSource` value the server's grammar would refuse (checked on
its NFC form, as the server checks it; the server stores that form) is omitted
with one line through the supplied `log` callback (the shipped CLI passes one),
and the receipt is stored unsourced if the remaining write succeeds — a READ or
WRITE failure can still prevent the receipt entirely.

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
- **Not verified as this receipt** — a row already at the receipt id not verified as
  this receipt: another agent's shared memory, or this agent's own row with
  different content, or a different host-source identity. The row is left
  untouched, the event is NOT acked, `receiptMismatched` names the id and the
  comparison that failed, and a one-shot run (`--once`) exits 2. A foreign PRIVATE
  row is not readable by the runner, so it reads as absent: the runner attempts
  the write and the server refuses that write instead — a named `receiptFailed`,
  the row untouched, not acked.
- **Failed** — anything else: a network error or timeout, 401, 403, 408, 429,
  a 5xx, or a failed read. The event is not acked, `receiptFailed`
  is set, the next cycle retries the receipt, and a one-shot run (`--once`)
  exits 2 (a poller under `--interval` keeps polling).

Covered by `test/integration/host-source-cursor-launch-receipt-1940.test.ts`
(the runner cycle against a real Harper — it also pins that an unrelated memory at
the receipt id, and the runner's own row with different content, are a named
`receiptMismatched`, left untouched and not acked; that a foreign PRIVATE row
reads as absent, so the runner's write is refused by the server and the event is
not acked; and that a source id the server stores NFC-normalised is still
verified on replay) and
`test/integration/cursor-wake-cli-launch-receipt-1940.test.ts` (the shipped CLI
through the real Flair client and Harper, with a local Cursor HTTP fixture). `test/host-source-parity.test.ts` runs the runner's copy of the
grammar and the server's `validateHostSource` over the same inputs;
`test/serialize.test.ts` pins that `--interval` never overlaps its own cycles.

Skipped events are ackable without a launch or receipt. A later failure can still
ack earlier successful or skipped events in the cycle.

## Wake trigger

Pick one. All of them invoke this same process — that is what makes launch idempotent.

1. **Scheduled poll (recommended)** — cron, launchd, or systemd oneshot every minute (`--once`).
2. **Long-running poller** — `--interval 60` under a supervisor.
3. **Cursor Automation cron** — the automation's prompt must *run this CLI*, not "start a cloud agent on the latest issue". The automation is only the timer.

`GET /OrgEventCatchup/{agentId}` is the wake path. A2A `message/stream` SSE polls the same queue; the runner talks to catchup directly.

## Convention

See [`packages/cursor-flair/skills/coordinate`](../cursor-flair/skills/coordinate/SKILL.md): `coord.dispatch` to wake, watermark ack after handoff, optional `coord.ack` / `coord.done` status events. Heavy spec stays in GitHub.
