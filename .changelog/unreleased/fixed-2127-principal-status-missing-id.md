- **`flair principal disable` and `enable` refuse an id with no row by name before writing.**
  The command reads the principal first and exits non-zero with `no principal
  <id>` when the row is absent, so no update is sent for a missing id. A read
  that fails or returns an unreadable body is refused as unverified, not as
  absent. After a confirmed update the command prints the status read back, and
  refuses when the read-back does not show the requested status.
