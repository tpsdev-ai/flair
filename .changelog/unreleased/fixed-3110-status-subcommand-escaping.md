- **`flair status federation` and `flair status rem` escape the stored fields they print.**

  The federation subcommand escapes the instance id, role and status and each
  peer's id, role, status, liveness and last-sync timestamp; the rem subcommand
  escapes the stored nightly timestamp. A value carrying a control, format,
  surrogate, unassigned, line- or paragraph-separator code point is shown as a
  visible `\u{...}` escape, as in the default and deep views. JSON output is
  unchanged.
