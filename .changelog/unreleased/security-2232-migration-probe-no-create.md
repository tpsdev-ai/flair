- **The migration probe does not create candidate directories and rejects symlinked candidate or migration-state paths when probed (flair#2232).**

  > **Heads-up:** a usable `~/.flair/data` wins ahead of `ROOTPATH` regardless of which instance runs; an absent or unusable default loses.
  > Set `FLAIR_MIGRATION_DATA_DIR` to separate custom migration state.
