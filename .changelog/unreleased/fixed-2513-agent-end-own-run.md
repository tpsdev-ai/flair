- **`agent_end` capture accounts the new messages in a session snapshot to the run that delivered it, best effort, failing closed where ownership is ambiguous (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing messages an earlier run had already captured
  again under the new run's id. For a callback that carries a session id, the capture
  path now identifies each snapshot message by its role, raw JSON content and
  stringified timestamp, and counts, per session, the occurrences of each identity it
  has accounted for. The occurrences beyond that count belong to the run whose
  `agent_end` delivered the snapshot. That run captures them; a run refused by policy
  (the host reported `success: false`, for an aborted run or a failed attempt alike;
  the run was already retired or aborted; it carried no run id; or its agent is not
  served) has them accounted to it as skipped; a run refused for now (no usable signing
  key, or the run map full) keeps its eligible messages pending under its own id.
  Scans of one session run one at a time, and a run is not retired while its scan
  waits. A pending capture is retried under its run's id by a later `agent_end` scan
  of the session that can capture and whose snapshot holds the message at least as
  many times as recorded, for up to `captureBounds.pendingRetryMs` (30 minutes), also
  after the run has retired but never once it is aborted; otherwise it expires with a
  log line and is not written.

  Limits: capture is best effort. The host has no committed-message event and no
  message id, so ownership is inferred from snapshot diffs, and where it is ambiguous
  nothing is captured. Messages can therefore be skipped: in a snapshot that holds
  fewer copies of an equal message than were recorded (as after a compaction), in a
  run refused by policy or past its retry window, in a run that finds its session's
  scan queue full (`sessionScanQueueCap` scans plus one deferred scan), and in a
  session disabled because a deferred skip would exceed `sessionMessageCap`
  identities. Messages with equal role, JSON content and stringified timestamp
  (numeric `1` and string `"1"` alike) share one identity, as can two messages
  through a 64-bit digest collision. A callback without a session id is not
  correlated with any other, and the per-session state is bounded
  (`sessionStateCap`, `sessionMessageCap`, `sessionPendingCap`): an evicted session
  or identity is forgotten, so a later run can capture its messages again, and its
  pending captures are dropped with a log line.
