- **A test-only hold at the start of a migration cycle, for observing boot-seeded progress.** A
  successfully claimed hold pauses after taking the cycle lock and before reading the state file.
  A go file, timeout, or marker I/O failure ends the hold.
