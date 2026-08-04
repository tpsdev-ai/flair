- **`--admin-pass`'s help text and error no longer promise something the code deliberately refuses.**
  For a remote target, `flair mcp enable` requires the password explicitly — `FLAIR_ADMIN_PASS` and
  `~/.flair/admin-pass` are skipped on purpose, because they are *this* machine's local admin
  credentials and sending them to another instance is how a local secret ends up on someone else's
  Harper. That guard is correct and unchanged.

  What was wrong is that three places described it three different ways: `--help` and the error both
  said `FLAIR_ADMIN_PASS` would work, one call-site comment described the goal as blocking only the
  *file* fallback, and the resolver's own doc said both legs are skipped. Only the last matched the
  code, and it was the one an operator never sees.

  The error now says explicitly that the env var and the local file are not used for a remote target
  **and why**, so the refusal is actionable instead of looking like a bug. Reported by an operator who
  had exported `FLAIR_ADMIN_PASS`, watched it be ignored, and reasonably filed it as broken.
