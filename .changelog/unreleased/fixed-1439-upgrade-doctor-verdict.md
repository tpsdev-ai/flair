- **`flair upgrade` reports the same install-health verdict as `flair doctor`.** Both
  commands run one enumerable catalog (MCP block, FLAIR_URL, CLAUDE.md, SessionStart
  hook, verified-read plan, keys classification, launchd). Adding a check to that
  catalog widens both. `✅ verified: healthy` prints only when every member ran and
  none failed. An unrun check can never look like a pass. A missing Codex
  SessionStart hook (which 0.49.0 `init` never wrote) no longer hides behind a
  green upgrade line.

  Installing the hook is consent-bearing — it executes at every session start. Interactive
  upgrades prompt; non-interactive upgrades name the gap and withhold ✅. Pass
  `--install-hooks` to consent without a prompt. `flair init` now writes the Codex hook
  when wiring Codex (opt out with `--skip-hook`), so a fresh install still passes `doctor`.
