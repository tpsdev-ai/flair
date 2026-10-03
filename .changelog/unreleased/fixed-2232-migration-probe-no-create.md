- **The migration data-dir probe never creates a candidate directory.** It refuses candidate and `.migrations` symlinks present at the probe (flair#2232). Node offers no openat-style handle; a swap after the check is not prevented.

  > **Heads-up:** a usable `~/.flair/data` wins ahead of `ROOTPATH` regardless of which instance runs; an absent or unusable default loses.
  > Set `FLAIR_MIGRATION_DATA_DIR` to separate custom migration state.
