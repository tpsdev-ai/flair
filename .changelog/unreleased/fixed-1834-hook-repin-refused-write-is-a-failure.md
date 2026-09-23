- **A Flair SessionStart hook re-pin no longer reports success when its write was refused.**

  `flair upgrade` and `flair doctor --fix` re-pin an already-wired
  `flair-session-start` hook. The result recorded an "update" before the write,
  so when the atomic write refused — a staging or rename failure, or an
  unwritable destination — the run still reported ok with "re-pinned …", and
  `flair doctor` rendered a success for a write that never happened. The result
  now follows what the write actually did: a committed write reports the update,
  and a refusal reports a failure (`ok: false`, action "skip") carrying the write
  layer's own message. The settings file is left byte-identical when the write
  is refused.

  (Refs #1834)
