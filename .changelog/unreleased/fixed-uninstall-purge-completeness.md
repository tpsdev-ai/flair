- **`flair uninstall --purge` now removes secrets, schedulers, and client wiring, and names what it leaves.** Purge used to delete only `~/.flair/data` and `~/.flair/keys` while printing "Flair fully purged", leaving `admin-pass`, backups/logs/upgrade-snapshots, the REM nightly shim and systemd/launchd units, and MCP/hook entries in client configs (flair#853).

  The npm package is listed as an intentional leftover with `npm uninstall -g @tpsdev-ai/flair` — this CLI cannot uninstall itself.

  > **Heads-up:** `--purge` now unwires Flair from `~/.claude.json`, `~/.codex/config.toml`, and the other MCP client configs, and removes REM/federation scheduler units. The `@tpsdev-ai/flair` package stays until you uninstall it.
