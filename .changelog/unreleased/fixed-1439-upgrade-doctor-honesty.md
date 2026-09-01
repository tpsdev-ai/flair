- **`flair upgrade` no longer contradicts `flair doctor` on the same machine.**
  Previously, upgrading from 0.49.0 to 0.50.0 with Codex already wired printed
  "✅ verified: healthy, authenticated, running 0.50.0" immediately followed by
  `flair doctor` exiting 1 with "✗ SessionStart hook (codex): not found" —
  two controls disagreeing about the same machine seconds apart (flair#1439).

  Two root causes fixed together:

  1. **Upgrade now applies pending version migrations automatically.** A new
     `applyUpgradeMigrations(fromVersion, toVersion, ctx)` step runs before the
     post-upgrade catalog run. The first migration (`session-start-hook@0.50.0`)
     installs the missing SessionStart hook for harnesses already wired on the
     machine — the user consented when they ran `flair init`. No new flag
     required; no consent prompt needed (the integration was already approved).
     Idempotent: a no-op when the hook already exists. Only fires for harnesses
     the user actually wired (never newly wires a harness they never had).

  2. **Upgrade's success marker now means the same thing as `flair doctor`.**
     `renderVerifiedSummary` gates the unqualified "✅ verified: healthy" on the
     shared `runDoctorChecks` catalog — the same set `flair doctor` runs.
     Adding a doctor check automatically widens upgrade's claim. "healthy" is
     printed only when every catalog member passes or skips. Refs #1439.
