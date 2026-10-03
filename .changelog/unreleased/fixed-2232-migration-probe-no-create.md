- **The migration data-dir probe never creates a candidate directory that does not already exist.** The first
  existing *usable* candidate wins, so a fresh custom `--data-dir` instance keeps migration state beside its data
  rather than creating `~/.flair/data/.migrations` (flair#2232).

  > **Heads-up:** on a host running both a default and a custom instance, migration state resolves to the default's
  > `~/.flair/data`; point `FLAIR_MIGRATION_DATA_DIR` at the custom instance's directory to separate them.
