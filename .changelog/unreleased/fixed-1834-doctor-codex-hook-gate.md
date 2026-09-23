- **`flair doctor` now checks a wired Codex SessionStart hook whatever Codex's install state.**

  Doctor's Codex hook arm was gated on Codex being detected/configured (a
  `codex` binary on PATH or a wired `~/.codex/config.toml`), so a machine with a
  wired `~/.codex/hooks.json` but no detectable Codex silently skipped the hook
  — including a HOLD that should have been printed. A hook file on disk is the
  wiring: the Codex SessionStart hook is now inspected whenever it is present
  on disk, and a `codexConfigured` box with no hook still reports the missing
  hook and offers the fix.

  (Refs #1834)
