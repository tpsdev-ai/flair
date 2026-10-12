- **`agent_end` accounts the new messages in a session snapshot to the run that delivered it, within the limits below (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing messages an earlier run had already captured
  again under the new run's id. For a callback that carries a session id, the capture
  path now identifies each snapshot message by its role, raw content and timestamp
  and counts, per session, the occurrences of each identity it has accounted for. The
  occurrences beyond that count are new and belong to the run whose `agent_end`
  delivered the snapshot. That run captures them; a run refused by policy (it failed,
  was already retired or aborted, carried no run id, or its agent is not served) has
  them accounted to it as skipped, so no later run captures them; a run refused for
  now (no usable signing key, or the run map full) keeps its eligible messages pending
  under its own id. Scans of one session run one at a time, and a run is not retired
  while its scan waits. A pending capture (that, or a write that failed) is retried
  under its run's id by a later `agent_end` scan of the session that can capture and
  whose snapshot holds the message at least as many times as recorded, for up to
  `captureBounds.pendingRetryMs` (30 minutes), also after the run has retired but not
  after it was aborted; otherwise it expires with a log line.

  Limits: a callback without a session id is not correlated with any other, so its
  whole snapshot is treated as new. A message whose role, timestamp or JSON content
  the host changes is treated as new. When a snapshot holds fewer copies of a message
  with the same role, content and timestamp than were recorded (as after a
  compaction), no copy is captured, its pending captures expire, and a diagnostic is
  logged, because a new copy cannot be told apart from an earlier one. Per session,
  the plugin keeps at most `sessionMessageCap` identities, `sessionPendingCap` pending
  captures and `sessionScanQueueCap` queued scans, and it holds `sessionStateCap`
  sessions, exceeded only while more sessions than that have a scan in flight. At
  those caps an evicted identity or session is forgotten (its messages may be
  captured again, and its pending captures are dropped with a log line), a pending
  capture over the cap expires with a log line, and a run that finds the scan queue
  full captures nothing from its snapshot, which is accounted to it as skipped (also
  logged).
