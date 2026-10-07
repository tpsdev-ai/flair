- **A refused symlinked migration data directory now says why it was refused and how to fix it, not just "not a directory".** The refusal names the configured path, the real path it resolves to, why the symlink is refused, and the remedy (flair#2277).

  The boot log, the per-migration failure reason and `lastCycleError` in `/HealthDetail`, and `flair doctor`'s Migrations section carry the same message. A symlinked `.migrations` child is refused the same way.

  > **Heads-up:** to use a data directory that currently lives behind a symlink, stop Flair, move the directory to the configured path, remove the symbolic link and start Flair; or point `FLAIR_MIGRATION_DATA_DIR` at the real path and restart.
