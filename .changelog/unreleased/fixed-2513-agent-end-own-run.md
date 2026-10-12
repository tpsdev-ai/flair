- **`agent_end` captures only the messages its own run added, and a failed write keeps its run (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing messages an earlier run had already captured
  again under the new run's id. For a callback that carries a session id, the capture
  path now identifies each snapshot message by its role, raw content and timestamp
  and counts, per session, the occurrences of each identity it has accounted for.
  Only the occurrences beyond that count are captured, under the run that ended, so
  a later run does not store a message an earlier run handled. Scans of one session
  run one at a time, and a run is not retired while its scan waits. A failed write
  stays pending under its run's id: a later `agent_end` scan of the session whose
  snapshot still holds the message retries it under that id for up to
  `captureBounds.pendingRetryMs` (30 minutes), also after the run has retired but not
  after it was aborted; past that the write expires with a log line.

  Limits: a callback without a session id is not correlated with any other, so its
  whole snapshot is treated as new. A message whose content the host rewrites is
  treated as new. When a snapshot holds fewer copies of a message with the same role,
  content and timestamp than were recorded (as after a compaction), none of those
  copies is captured and a diagnostic is logged, because a new copy cannot be told
  apart from an earlier one. The state is bounded by `sessionStateCap` sessions and
  `sessionMessageCap` identities per session; the session map exceeds its cap only
  while more sessions than the cap have a scan in flight. An evicted session or
  identity is forgotten, so its messages may be captured again, and its pending
  writes are dropped with a log line.
