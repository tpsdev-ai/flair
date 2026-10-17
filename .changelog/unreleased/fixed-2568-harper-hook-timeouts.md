- **Test-harness Harper before/after hooks pass explicit lifecycle timeouts, and an overrunning `stopHarper` rejects with a named error carrying its pid and phase.** (#2569)

  Hooks that call `startHarper`/`stopHarper` directly and relied on Bun's 5 s
  default (or a bare `120_000` literal) now pass `HARPER_START_BUDGET_MS`
  (boot) or `HARPER_STOP_BUDGET_MS` (stop); hooks that already carried their
  own larger explicit budget keep it unchanged. `stopHarper` bounds the
  caller's wait, not the work: past its deadline it rejects with
  `HarperStopTimeoutError`, naming the pid and the phase it stalled in, while
  the stop work it raced (termination, lock wait, or install-dir removal) can
  continue in the background; a stop that fails
  some other way first rejects with that error. `stopHarpers` runs several
  stops concurrently, and the `HARPER_STOP_BUDGET_MS` hooks that stopped
  several Harpers in sequence now use it (or, for a replicated pair, a pair
  `stop()` that stops both nodes concurrently), so their stops settle inside
  the hook's budget. A hook that propagates the failure then reports the named
  error; the best-effort teardowns catch stop failures and discard it, as
  before. The readiness budget is one documented constant
  (`HARPER_STARTUP_BUDGET_MS`), kept equal to the duration `flair init`'s TCP
  readiness check polls under. The harness's startup and readiness timeout
  diagnostics, and its exited-during-readiness diagnostic, name the elapsed
  time and a phase: the one named by the last captured log line shaped like
  Harper's startup diagnostic, or the harness's label when no line matches.
  `flair init`'s credential-gate readiness refusal names its phase, with the
  time waited only when init spawned the instance. Unit tests fail a hook in
  `test/` that calls `startHarper`, `stopHarper` or `stopHarpers` directly
  without a timeout argument, and a `HARPER_STOP_BUDGET_MS` hook that calls
  `stopHarper`/`stopHarpers` directly at more than one site or in a loop.
