- **`agent_end` capture treats only the messages new to a session's snapshot as a run's own (best effort); failed captures are dropped, not retried (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing messages an earlier run had already captured
  again under the new run's id. For a callback that carries a session id, the capture
  path now identifies each snapshot message by its role, JSON content and stringified
  timestamp, and counts, per session, the occurrences of each identity it has
  recorded. The occurrences beyond that count are treated as new, and as messages of
  the run whose `agent_end` delivered the snapshot: that run captures them, or, when
  it does not capture (the host reported `success: false`; the run was retired or
  aborted, carried no run id, or its agent is not served; no usable signing key; the
  run map full), they are recorded as skipped with a log line. A capture whose write
  fails is dropped with one log line and recorded as skipped; it is never retried, by
  that run or a later one. Scans of one session run one at a time, and a run is not
  retired while its scan waits.

  Limits: capture is best effort, because the host has no committed-message event and
  no message id. An earlier message that the host rewrites gets a new identity and may
  be captured under the later run whose snapshot first holds the rewritten form.
  Messages with equal role, JSON content and stringified timestamp (numeric `1` and
  string `"1"` alike) share one identity, as can two messages through a 64-bit
  digest collision; when a snapshot holds fewer such copies than were recorded (as
  after a compaction), no copy is captured. A callback without a session id is not
  correlated with any other. A callback that finds `sessionScanQueueCap` scans queued
  for its session disables capture for that session (logged once). Per-session state
  is bounded (`sessionStateCap` sessions, `sessionMessageCap` identities per session);
  an evicted session or identity is forgotten, so a later run can capture its
  messages again.
