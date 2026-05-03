# Task-Completion Session Reset

> Tie agent session lifecycle to task completion. On a successful DONE, write a task summary to Flair, reset the session, and bootstrap the next dispatch fresh from SOUL + recent memories.

**Status:** Draft — for K&S review
**Priority:** P1 — Flair 1.0
**Owner:** Flint
**Bead:** ops-9wji proposal B (proposals A and C resolved by ops-czop / @tpsdev-ai/openclaw-flair v0.7.0; D deferred post-1.0)

---

## § 1 Problem

Long-running agent sessions accumulate two kinds of context decay:

1. **Heartbeat-bloat.** Anvil's session ran 50%+ HEARTBEAT_OK turns over hours. Each new dispatch replays the full conversation → 370KB prompts → model can't extract signal → empty completions or tool-call hallucinations. (Mitigated upstream by openclaw's built-in `filterHeartbeatPairs` — but not eliminated; long sessions still drift.)

2. **Across-task bleed.** State from task N (file paths, ack patterns, half-formed reasoning) leaks into task N+1's context. Even when the new dispatch is well-specced, the leading context biases the agent toward the prior task's shape — visible as scope creep on follow-ups, hallucinated file paths from earlier work, and the "receive-then-silently-file" pathology.

Anchor re-injection (ops-czop) addresses (1) for behavioral rules. It does NOT address (2) — task-shape bleed is a different lifecycle problem.

## § 2 Guiding contract

Two inviolable rules:

1. **A reset is observable.** The agent gets a clear "previous task complete; new context starts here" signal in their next dispatch. No silent context wipes.
2. **Continuity is preserved via Flair.** Anything the agent learned in the resetted session is captured as a Memory write before the reset. Behavior changes; lessons compound. (The reset is *fresh slate for working memory*, not *amnesia for what was learned*.)

Any feature that violates these gets cut.

## § 3 Trigger conditions

Three events that should cause a session reset:

1. **DONE-with-CI-green.** Agent emits a DONE message + the CI-gate (ops-9oye) confirms green. This is the canonical "task succeeded" signal.
2. **Acked task close.** Operator (Flint or Nathan) explicitly closes a Bead linked to the agent's working branch.
3. **Manual override.** `tps mail send <agent> --reset-session` for cases where (1) and (2) don't fire but the operator wants a fresh slate.

Out-of-scope for 1.0: heuristic auto-reset (e.g. "session > N turns + idle for M min"). Heuristics here would over-fire or under-fire silently, violating rule 1. Stick to explicit triggers.

## § 4 Reset pipeline

On a trigger event, the agent's launcher (or its harness wrapper) executes:

1. **Capture task summary.** Compose a memory:
   - `agentId` = the agent's id
   - `content` = a structured summary: task name, beads/PR id, outcome (merged | rejected | abandoned), files touched, lessons-if-any
   - `summary` = one-paragraph compression (uses ops-wkoh slice-1's new field)
   - `subject` = "task:<beads-id>"
   - `tags` = ["task-summary", "auto-on-reset"]
   - `durability` = "persistent"
   - `derivedFrom` = relevant Memory IDs the agent referenced or wrote during the task

2. **Write to Flair.** PUT /Memory/<id> via the agent's keypair. Failure to write blocks the reset (don't lose the lesson).

3. **Snapshot the session.** Tar.gz the current openclaw session jsonl (or equivalent for non-openclaw harnesses) into `~/.flair/snapshots/<agentId>/sessions/<beads-id>-<ts>.tar.gz`. Retain 30 days. Belt-and-suspenders: if the summary write captured the wrong lesson, the operator can restore + re-summarize.

4. **Reset the harness.** End the current session — this is harness-specific:
   - **OpenClaw** — `openclaw session end <agent>` (or equivalent termination hook). Next dispatch starts a fresh agent with cold session state.
   - **`pi`-based agents (Ember)** — analogous: terminate the pi process; next dispatch boots cold.
   - **Claude Code (Flint)** — out of scope for this spec; Claude Code's session model is different. Operator-driven `/clear` is the analogue.

5. **Emit reset notification in next dispatch.** When the next task mail arrives, the launcher prepends a system message:

   ```
   [Session reset: previous task <beads-id> closed (outcome: <merged|rejected|...>).
    Task summary written to Flair as <memory-id>; restorable from snapshot
    ~/.flair/snapshots/.../<beads-id>-<ts>.tar.gz.]
   ```

   This satisfies rule 1 (observable). The agent knows where they are in the task arc.

## § 5 Bootstrap shape after reset

The first turn of the new session bootstraps from:

- **SOUL.md / IDENTITY.md / AGENTS.md** (already covered by the openclaw-flair anchor injection — fires on every turn, not just bootstrap)
- **Recent task summaries** (`flair memory search --tags task-summary --limit 5 --since 7d` — surfaces what the agent worked on lately)
- **The new task mail** (the dispatch itself)

Agents arrive with: who they are, what they recently did, and what they're being asked to do now. No bleed from the prior task's file paths or half-formed reasoning.

## § 6 Failure modes

- **Reset trigger fires but Flair is unreachable.** The summary write fails. Block the reset; surface to the operator via mail-bounce or stderr. Don't drop the lesson.
- **Multiple triggers fire concurrently** (e.g. DONE-with-CI-green AND operator-acked at the same time). Idempotent: first trigger wins, subsequent triggers no-op.
- **Reset fires mid-task** (e.g. the agent emits DONE but the operator hasn't acked, AND the operator explicitly resets). Operator override wins; summary captures whatever the agent said it accomplished, even if not yet ack'd.
- **Cross-host reset** (agent on tps-anvil, summary write to rockit-Flair via federation). Works as long as federation is healthy; no special handling.

## § 7 What this does NOT replace

- **Heartbeat filter** (ops-czop / openclaw built-in) — different problem; runs every turn.
- **Anchor re-injection** (ops-czop / openclaw-flair v0.7.0) — different problem; runs every turn.
- **Calibration probes** (ops-9wji proposal D) — periodic out-of-band "do you still know rule X" checks. Deferred post-1.0 unless we hit a regression that motivates it.

This spec is *only* the lifecycle hook for end-of-task reset.

## § 8 Implementation slices

| Slice | Scope | Owner |
|---|---|---|
| 1 | Task-summary write helper (`flair memory write-task-summary <agent> --beads <id> --outcome <s> --files-touched <csv> ...`) — single CLI entry point that any harness can invoke | Flint |
| 2 | Session-snapshot tar.gz utility — same shape as the FLAIR-NIGHTLY-REM `flair rem snapshot` command but session-scoped | Flint |
| 3 | OpenClaw harness integration — wire the launcher to detect DONE-with-CI-green, call slice 1 + 2, emit reset notification in next dispatch | Anvil (his launcher) + Flint (gateway end) |
| 4 | Pi harness integration — analogous for Ember | Ember |
| 5 | Operator-acked Bead-close trigger — beads webhook that fires reset for the linked agent | Flint |
| 6 | Manual override (`tps mail send <agent> --reset-session`) | Flint |

Slices 1+2 are tooling — useful regardless of the harness integration. Land first.
Slices 3+4 are harness-specific and can run in parallel.
Slices 5+6 are the operator surfaces.

## § 9 Open questions for K&S

1. **Slice ordering.** OK to land 1+2 first as standalone tools? Worth a smoke-test of the harness integration shape before committing to the full slice 3+4 design?

2. **Snapshot retention.** Spec proposes 30 days. Lower bound is "as long as the matching task summary's `derivedFrom` chain is meaningful" — could be shorter. Upper bound is "as long as it doesn't fill disk." Prefer 30 days?

3. **Reset notification placement.** As a system message in the next dispatch (§ 4 step 5)? Or as a separate "reset-event" memory the agent reads from Flair on bootstrap? System message is cheaper but makes the bootstrap path more harness-specific.

4. **Cross-host federation latency.** If Anvil resets on tps-anvil and writes a task summary to anvil's local Flair, the summary doesn't show up on rockit-Flair until federation sync. For 1.0 we accept the delay (max ~minutes); flag if you'd want explicit sync-on-write.

## § 10 Out of scope for 1.0

- Heuristic auto-reset (rejected per § 3).
- LLM-generated task summary (1.0 = agent self-writes; SLM-generated post-1.0 per ops-pykg).
- Cross-agent reset coordination (e.g. "reset all agents that touched this PR" — multi-agent reflection is 1.1+).
