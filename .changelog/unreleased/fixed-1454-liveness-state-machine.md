- **`flair stop` and `flair start` now decide liveness with a five-state machine instead of a single `lsof` probe** (Refs #1454).
  The old stop path ran `lsof -ti :<port>` and treated its `catch` as "nothing
  is listening" — so on a host without `lsof`, `flair stop` reported "not
  running" against a live daemon and `flair start` silently "succeeded" over it,
  and a `stop; start` wrapper (a systemd `Type=forking` unit's `ExecStop`, say)
  produced a second daemon while the first kept running. The new classifier
  distinguishes `RUNNING`, `NOT_RUNNING`, `WEDGED`, `DISAGREEMENT`, and
  `UNKNOWN`, and `lsof` absence no longer changes any verdict. Identity is
  carried by a sidecar (`<dataDir>/flair-daemon.json`) that flair writes at
  spawn — `{ pid, startTimeMs, port, flairVersion }` — and a pid is only ever
  signalled when its identity is verified (pidfile pid matches the sidecar, and
  the live process's start time matches within ±2s). A wedged daemon is
  recoverable only through that verified identity; the same evidence without
  proof is a `DISAGREEMENT` that refuses to act, so a recycled PID can no longer
  be mistaken for the instance. `flair start` over a live daemon now exits
  non-zero instead of 0.
