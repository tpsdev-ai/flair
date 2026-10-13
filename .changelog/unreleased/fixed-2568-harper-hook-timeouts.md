- **Test-harness Harper before/after hooks pass explicit lifecycle timeouts, and a slow stop fails with a named error carrying its pid and phase.**

  Hooks that start or stop a spawned Harper now pass an explicit lifecycle
  timeout instead of relying on Bun's 5 s default; the hooks that had none take
  `HARPER_START_BUDGET_MS` (boot) or `HARPER_STOP_BUDGET_MS` (stop). `stopHarper`
  bounds its own work and throws `HarperStopTimeoutError`,
  naming the pid and the phase it stalled in, when a stop overruns that budget.
  The readiness budget is one documented constant
  (`HARPER_STARTUP_BUDGET_MS`), pinned equal to the budget `flair init`'s TCP
  readiness check polls under, and the readiness failure message now names the
  phase it stopped in with the elapsed time. A lint-style unit test fails a hook
  in `test/` that omits its timeout.
