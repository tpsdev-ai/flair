- **`flair session snapshot list` no longer crashes when a snapshots directory exists.** The published build exited with a module-format error the moment `~/.flair/snapshots/` was present; the command now lists snapshots normally (flair#1653).

  The crash only appeared against an existing snapshots tree, so it could not
  reproduce on a clean machine and CI had no built-binary check for that path.
  A new dist-level smoke test now runs the shipped command with snapshots
  present, so the failure cannot return unnoticed.
