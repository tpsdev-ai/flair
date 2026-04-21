# FLAIR-NIGHTLY-REM: Automated Teaching Substrate

> Nightly memory hygiene + distillation, with rollback, staging, and an always-available pause. Makes "teach once, inherited forever" real by removing operator-discipline dependency.

**Status:** Draft
**Priority:** P0 — Flair 1.0
**Owner:** Flint
**Depends on:** Existing `flair rem {light,rapid,restorative}` commands (already shipped)
**Nathan green-light:** 2026-04-21T12:12Z

---

## § 1 Problem

`flair rem` exists today but runs **only when an operator remembers to run it.** Operator discipline decays the moment anyone is busy. The Flair product claim — *teach once, inherited forever* — is only true on days a human types `flair rem`.

Automation makes the "forever" part real. But unattended automation on a memory/soul store is dangerous: bad distillations get laundered through REM's authority, over-archiving silently drops load-bearing context, and silent drift becomes visible only weeks later.

**Solution:** nightly REM as a scheduled, observable, always-reversible cycle. Stage candidates, never auto-promote; snapshot before each run, always restorable; filter by trust tier; diff-ping the operator daily.

## § 2 Guiding Contract

Two inviolable rules, in this order:

1. **Every night is reversible.** `flair rem restore <date>` returns memory + soul to pre-cycle state with no data loss.
2. **Every promotion is deliberate.** REM never edits soul or promotes a memory to `durability=permanent` without an explicit human or high-trust-agent decision.

Any feature in this spec that conflicts with these rules gets cut, not softened.

## § 3 Command Surface

```
flair rem nightly enable [--agent <id>] [--at <HH:MM>] [--tz <zone>]
flair rem nightly disable [--agent <id>]
flair rem nightly status
flair rem nightly run-once [--dry-run]   # manual trigger, same code path

flair rem candidates [--agent <id>]       # list staged lessons
flair rem promote <candidate-id> --rationale "<why>" [--to soul|memory]
flair rem reject <candidate-id> --reason "<why>"

flair rem snapshot list [--agent <id>]
flair rem restore <date> [--agent <id>] [--dry-run]

flair rem pause                           # emergency stop
flair rem resume
```

Scheduler is platform-native: launchd on macOS, systemd timer on Linux. Installed by `flair rem nightly enable`. No in-process cron.

## § 4 Nightly Cycle Steps

Each nightly run, in order, with a failure-stops-the-cycle guarantee:

1. **Pre-flight.** Check `rem pause` flag. If set, log and exit.
2. **Snapshot.** Write `~/.flair/snapshots/<agent>/<ISO-date>.tar.gz` containing all memories + soul entries for the agent. Retain 30 days; prune older.
3. **Maintenance.** Soft-delete expired memories; soft-archive memories matching archive policy (see § 6).
4. **Trust-tier filter.** Select memories with `trust ∈ {endorsed, corroborated, battle-tested}` from the last N days (default 7) as reflection input. Unverified memories are excluded from distillation but remain retrievable.
5. **Distillation.** Call `/ReflectMemories` to generate candidate lessons. Store as `MemoryCandidate` rows (new table, § 7).
6. **Diff report.** Emit a structured event: `{archived, expired, consolidatedCount, candidates, snapshotPath}`.
7. **Operator ping.** Deliver diff via Discord webhook (if configured) or TPS mail to the agent's owner.

No step touches soul. No step promotes a candidate. Promotion is a separate, explicit human/agent action (§ 5).

## § 5 Candidate Staging & Promotion

Distillation emits candidates into a `MemoryCandidate` table. Each candidate carries:

```
id, agentId, sourceMemoryIds[], claim, rationalePrompt,
generatedBy (model/rev), generatedAt, status (pending|promoted|rejected),
reviewerId, reviewRationale, decidedAt
```

**Promotion requires rationale.** `flair rem promote <id> --rationale "<why>"` — both `--rationale` and `--to (soul|memory)` required. No rubber-stamp.

**Who can promote.** Default trust policy:
- Human (Nathan, or anyone with the admin keypair): any candidate → any target
- High-trust agent (`endorsed` tier): can promote to `durability=persistent` memory only, never to soul
- Standard/unverified agent: cannot promote

Rejected candidates retain full decision history so recurring false-positives become visible, not fresh. (Same principle as agentic-stack's `reject.py`.)

## § 6 Archive Policy (conservative defaults)

**Soft-archive, not hard-delete.** Every memory the nightly cycle archives remains retrievable for 30 days via `flair rem restore`. Hard deletion requires explicit `flair rem purge --older-than 30d --opt-in`.

Default archive triggers:
- `expiresAt < now` — expired per policy
- `validTo < now - 90d` AND `durability=ephemeral` — stale ephemeral
- `lastRetrieved < now - 180d` AND `durability=standard` AND `retrievalCount <= 1` — one-hit-wonder

`durability=persistent|permanent` memories are never auto-archived.

## § 7 New Schema

Add to `schemas/memory.graphql`:

```graphql
type MemoryCandidate @table(database: "flair") {
  id: ID @primaryKey
  agentId: String! @indexed
  claim: String!                # distilled lesson text
  sourceMemoryIds: [String]     # episodic memories feeding the distillation
  rationalePrompt: String       # the prompt given to the distillation LLM
  generatedBy: String           # model identifier
  generatedAt: String! @indexed
  status: String! @indexed      # pending | promoted | rejected
  target: String                # soul | memory (on promote)
  reviewerId: String            # who decided
  reviewRationale: String       # required on promote/reject
  decidedAt: String
  supersedes: String            # previous rejected candidate this replaces (recurrence tracking)
}
```

Candidates persist. Rejected candidates retain full history — recurring distillations surface as `supersedes` chains so the operator sees "this same lesson keeps getting proposed and rejected."

## § 8 Observability

Every nightly run writes a structured log row:

```json
{
  "agentId": "flint",
  "runAt": "2026-04-22T03:00:00Z",
  "snapshotPath": "~/.flair/snapshots/flint/2026-04-22.tar.gz",
  "archived": 12, "expired": 3, "consolidated": 4,
  "candidates": ["MC-xyz-1", "MC-xyz-2"],
  "durationMs": 4123,
  "errors": []
}
```

`flair rem nightly status` shows the last 14 runs as a sparkline + table. Drift becomes visible in under 24h, not weeks.

## § 9 Emergency Controls

- `flair rem pause` — writes `~/.flair/rem.paused` sentinel. Nightly runs check this first and exit.
- `flair rem restore <date>` — unpack snapshot, replay as the live state. Dry-run available.
- **Environment override:** `FLAIR_REM_PAUSE=1` in the agent's env also pauses. Lets ops pause fleet-wide without writing a file.

Escape hatches are always available, always idempotent.

## § 10 Dry-Run First Run

First time `flair rem nightly enable` is run for an agent, the next cycle runs with `--dry-run` implicit. The diff ping includes "PREVIEW — nothing changed. Run `flair rem nightly confirm` to go live." This prevents the automation from silently acting on an agent before the operator has seen what it will do.

## § 11 Out of Scope for 1.0

- **Auto-promotion of any candidate.** 1.0 promotions are always human/high-trust-agent. Auto-promotion on high-confidence candidates is 1.1+.
- **Cross-agent reflection.** 1.0 REM only distills from a single agent's memories. Multi-agent reflection (e.g., "what did all reviewers learn this week?") is 1.1+.
- **LLM-authored rationale.** The rationale on promote/reject is operator-written. An LLM-drafted rationale the human edits is 1.1+.
- **Cloud-hosted scheduler.** 1.0 uses platform-native schedulers (launchd/systemd). Fabric-hosted nightly is bundled with Flair-cloud post-1.0.

## § 12 Open Questions

1. **Where do candidates surface by default?** CLI (`flair rem candidates`) is minimum. Is a lightweight web UI in 1.0 scope? Leaning no — CLI is enough for the power-user audience; UI can wait.
2. **Diff ping default channel.** Discord webhook is easy for our team but requires config. TPS mail is universal but less visible. Default to TPS mail with Discord opt-in?
3. **Snapshot compression.** 30d of snapshots per agent × N agents × M bytes adds up. Default `tar.gz` is fine at 1.0 scale; revisit when a user has >1M memories.

## § 13 Implementation Notes (non-normative)

- Total work estimate: 1–2 days after the `MemoryCandidate` schema + promote/reject endpoints land. Most pieces already exist — nightly wiring is the connective tissue.
- Scheduler install is the only platform-specific code. Reuse `flair init`'s launchd/systemd templates.
- Snapshot format: plain `tar.gz` of a JSON export from `/MemoryExport` + `/SoulExport` endpoints. Keeps restore simple and auditable.

---

## Appendix: The Teaching Loop

```
human correction OR observed failure
   ↓
memory write (durability=persistent, source-tagged)
   ↓
(overnight)
   ↓
snapshot + trust-filtered reflection
   ↓
MemoryCandidate rows (staged, not promoted)
   ↓
operator reviews via `flair rem candidates`
   ↓
promote (with rationale) → soul OR persistent memory
   ↓
next session bootstraps with the lesson prefetched
   ↓
behavior changes; lesson compounds across agents via federation
```

This is what "teach once, inherited forever" looks like when it's real. Every arrow is visible, every arrow is reversible, every promotion is deliberate.
