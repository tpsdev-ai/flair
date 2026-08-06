- **`flair mcp enable` verifies the process actually restarted.** Before
  calling `restart`, the command captures the running process PID via the
  ops API and re-checks it after the restart completes. If the PID is
  unchanged (thread bounce / no-op restart) the step fails with a
  loud error naming the actor, state, and remedy, and `enable` exits
  non-zero without printing a success checkmark. Fixes #1120 (sub-issue A).
