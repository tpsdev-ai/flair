# FLAIR-NIGHTLY-REM — Slice 1 Implementation Design

> Companion planning doc for the slice-1 build (scheduler + snapshot + restore). Parent spec: `FLAIR-NIGHTLY-REM.md`. Branch: `feat-rem-nightly-slice-1`.

**Status:** Design checkpoint, 2026-05-14
**Owner:** Flint
**Why this doc:** the spec is a contract; this doc is the *implementation map*. Tracks what already exists so we don't re-invent, and what's left to build so the slice is scoped.

---

## § 1 What already exists (verified by grep, 2026-05-14)

These were built ahead of slice 1 by earlier work (ops-2qq slices 1+2 and ops-ojht session-snapshot):

1. **`MemoryCandidate` table** — `schemas/memory.graphql:84`. Full shape per spec § 7.
2. **`flair rem candidates`** — `src/cli.ts:3979`. Lists pending candidates.
3. **`flair rem promote`** — `src/cli.ts:4109`. `--rationale` + `--to` required.
4. **`flair rem reject`** — `src/cli.ts:4210`. `--reason` required.
5. **`flair rem rapid` / `light` / `restorative`** — `src/cli.ts:3776/3856/3899`. On-demand distillation (Dreams-equivalent).
6. **Health endpoint REM block** — `resources/health.ts:330-373`. Already looks for:
   - `~/Library/LaunchAgents/dev.flair.rem.nightly.plist` (darwin marker)
   - `~/.config/systemd/user/flair-rem-nightly.timer` (linux marker)
   - `~/.flair/logs/rem-nightly.jsonl` (audit log — `nightlyLog` variable)
   - `MemoryCandidate.status=pending` count (pendingCandidates)
   - Warns if `lastNightlyAt > 48h` ago.
7. **`flair status rem`** — `src/cli.ts:4651-4674`. Shows the above.
8. **`flair session snapshot {create|list|restore}`** — `src/cli.ts:5837-5984`. The exact tar.gz + 600-perms + `~/.flair/snapshots/<agent>/...` pattern slice 1 must mirror.

**Implication:** Slice 1 is the connective tissue between (1)-(5) and (6)-(8). The harness pieces are mostly in place.

## § 2 What slice 1 must add

Per spec § 3 command surface, ordered by build-up:

### A. The nightly runner (the script the scheduler invokes)

A standalone executable that, when run, performs spec § 4 steps 1-6:

1. Check `~/.flair/rem.paused` and `FLAIR_REM_PAUSE=1` → exit cleanly if paused.
2. Pre-cycle snapshot to `~/.flair/snapshots/<agent>/<ISO-date>.tar.gz`.
3. Maintenance (delegate to existing `rem light` code path).
4. Trust-tier filter (default: endorsed+ from last 7d).
5. Distillation (delegate to existing `/ReflectMemories` resource — same path as `rem rapid`).
6. Append a row to `~/.flair/logs/rem-nightly.jsonl`.

**Implementation form:** dedicated TS module `src/rem/nightly-runner.ts`, exported as both a function (for `flair rem nightly run-once`) and the entry point of a thin `bin/flair-rem-nightly` script that scheduler timers exec directly. The scheduler doesn't need to know about npx/bun — it points at one absolute path.

### B. Snapshot module (reusable by both nightly runner and `flair rem snapshot`)

Mirror the `flair session snapshot` pattern at `src/cli.ts:5837` but rooted at `~/.flair/snapshots/<agent>/<ISO-date>.tar.gz` (no `sessions/` subdir — REM snapshots live at the agent root).

Contents of the tarball:
- `memories.jsonl` — full agent memory export (via existing `/MemoryExport` if it exists, else direct table dump)
- `soul.json` — soul snapshot (via existing `/SoulExport` if it exists)
- `metadata.json` — agent id, run id, flair version, candidate counts at snapshot time

Perms 600 (owner-only) matching the session snapshot pattern.

**To verify before code lands:** existence + shape of `/MemoryExport` and `/SoulExport` resources. If they don't exist yet, dump directly from `databases.flair.Memory.search({})` and `databases.flair.Soul.get(agentId)`.

### C. CLI subcommands

```
flair rem nightly enable [--agent <id>] [--at <HH:MM>] [--tz <zone>]
flair rem nightly disable [--agent <id>]
flair rem nightly status                    # delegates to existing `flair status rem`
flair rem nightly run-once [--dry-run]       # invokes nightly-runner

flair rem snapshot list [--agent <id>]      # mirror of session snapshot list
flair rem restore <date> [--agent <id>] [--dry-run]   # untar + replay
```

### D. Scheduler templates

**macOS launchd** — `templates/launchd/dev.flair.rem.nightly.plist.tmpl`:
- StartCalendarInterval at user-specified hour:min (default 03:00 local)
- ProgramArguments points to `~/.flair/bin/flair-rem-nightly` (deployed by `nightly enable`)
- StandardOutPath + StandardErrorPath under `~/.flair/logs/`
- RunAtLoad=false (the timer fires on schedule, not at session boot)

**Linux systemd** — `templates/systemd/flair-rem-nightly.{service,timer}.tmpl`:
- OnCalendar=*-*-* HH:MM:00
- Persistent=true (catches missed runs after a sleep/reboot)
- After=network.target (Harper local socket, but still — be safe)

`flair rem nightly enable` does the install:
1. Render template → target path with substituted values
2. `launchctl bootstrap gui/<uid> <plist>` (macOS) or `systemctl --user daemon-reload && systemctl --user enable --now flair-rem-nightly.timer` (linux)
3. Deploy the `flair-rem-nightly` shim script to `~/.flair/bin/` if not already present.

`flair rem nightly disable` does the inverse: launchctl bootout / systemctl --user disable --now + remove template files (NOT the audit log + snapshots).

### E. `~/.flair/rem.paused` flag file + `FLAIR_REM_PAUSE` env check

`flair rem pause` → `touch ~/.flair/rem.paused`
`flair rem resume` → `rm -f ~/.flair/rem.paused`
Runner checks both before any side effect.

### F. Dry-run first run guard (spec § 10)

Implementation note: `~/.flair/rem.nightly.confirmed` sentinel. `nightly enable` does NOT create it. First nightly cycle sees the missing sentinel → runs in dry-run mode → emits a special log row → exits without writing candidates. `flair rem nightly confirm` creates the sentinel after the operator has seen the dry-run output. Same one-time guard the spec asks for.

## § 3 Out of scope for slice 1 (slice 2 work)

Per spec, these can land separately and the slice-1 release is still load-bearing:

- Trust-tier filter beyond the default (operator can override `--trust-min` in slice 2).
- Webhook / push channels — slice 1 is CLI-only per spec § 8.
- Auto-promotion — never in 1.0 per spec § 11.

## § 4 Risks + open questions

1. **`/MemoryExport` / `/SoulExport` existence.** Need to verify or build direct table-dump fallbacks. Decision point at start of implementation.
2. **launchd vs LaunchAgent rotation.** If a `dev.flair.rem.nightly.plist` already exists, `enable` overwrites; we should `launchctl bootout` first to avoid duplicate-loaded states.
3. **Time zones.** macOS launchd respects local tz; systemd OnCalendar can be zoned. Default to local; `--tz` is slice-2 nice-to-have.
4. **Bun vs Node for the shim.** The shim invocation must work whether the user has bun, node, or only Flair's bundled runtime. Approach: shim resolves the runtime in PATH order, prefers bun, falls back to node. Test on a clean macOS.
5. **Failure-stops-the-cycle (spec § 4 lead).** Each step needs explicit error capture into the jsonl row (`errors: []`) AND a non-zero exit so launchd/systemd marks the run failed. Don't swallow errors.

## § 5 Test plan

Per `feedback_real_fixes.md`:

1. **Unit:** snapshot create → list → restore round-trip preserves byte-identical memory rows.
2. **Unit:** runner with `FLAIR_REM_PAUSE=1` exits without side effects.
3. **Unit:** runner with no candidates emits one jsonl row with `candidates: []` and exits 0.
4. **Integration:** `flair rem nightly enable && flair rem nightly run-once && flair rem nightly status` shows the expected fields after a real (test-agent) cycle.
5. **Integration:** `flair rem restore <date> --dry-run` lists tarball contents without writes.
6. **macOS:** `launchctl print gui/<uid>/dev.flair.rem.nightly` shows the loaded job after `enable`.
7. **Linux:** `systemctl --user status flair-rem-nightly.timer` shows active after `enable`.

## § 6 Estimate

Per spec § 13: 1-2 days after prerequisites. Prerequisites confirmed shipped. Slice 1 alone:

- A (runner): 4h
- B (snapshot module): 3h
- C (CLI wiring): 2h
- D (scheduler templates + install/uninstall): 4h
- E (pause/resume): 1h
- F (dry-run first run): 1h
- Tests: 4h
- Docs: 2h

**Total: ~3 focused days, no rush.** Nathan green-lit "no rush" 2026-05-14.

## § 7 Sequencing for the PR cadence

Land slice 1 as **two PRs**, not one big merge:

1. **PR-1 (`feat-rem-nightly-runner`):** runner + snapshot module + CLI subcommands + `pause`/`resume`. Standalone-runnable via `flair rem nightly run-once`. No scheduler templates yet. Fully testable on its own.
2. **PR-2 (`feat-rem-nightly-scheduler`):** launchd + systemd templates + `enable`/`disable`. Adds the "automation" layer on top of PR-1.

Each PR through K&S ensemble. PR-2 unblocks the spec's "every night is reversible" claim becoming load-bearing.

---

## Implementation kickoff checklist (for next session)

- [ ] Verify `/MemoryExport` + `/SoulExport` resource shape, or design fallbacks
- [ ] Verify `flair rem rapid` distillation entry point can be invoked as a function (not just a CLI handler)
- [ ] Sketch `~/.flair/bin/flair-rem-nightly` shim contents
- [ ] First commit: snapshot module + tests (smallest atomic piece, builds confidence)
- [ ] Second commit: runner with pause/resume + dry-run first-run guard
- [ ] Third commit: CLI subcommands + status pass-through
- [ ] Fourth commit: scheduler templates + enable/disable
- [ ] Final commit: docs/CHANGELOG
- [ ] K&S ensemble per [feedback_premerge_check_both_ks_on_gh.md]
