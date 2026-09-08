- **`flair keys prune` reports an unparseable `.key` as `unidentified` and leaves it alone.**
  Classification already refused to archive a file it cannot parse (a keystore blob in
  `~/.flair/keys/` is a live federation key, not junk — flair#1026). The command output
  still treated an unidentified-only directory as empty ("No key files found") and never
  printed the file. Unparseable keys are now listed as `unidentified`, counted separately
  from prunable `stale`/`invalid`, and stay on disk under `--apply`.
