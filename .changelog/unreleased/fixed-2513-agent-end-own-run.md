- **`agent_end` capture treats only messages new to a session's snapshot as a run's own (best effort); failed captures are dropped, not rescheduled (#2513).**

  `agent_end` receives the whole session's message snapshot, and the previous release
  rescanned it on every run, storing messages an earlier run had already captured
  again under the new run's id. For a callback that carries a session id, the capture
  path now identifies each snapshot message by its role, JSON content and stringified
  timestamp, and counts, per session, the occurrences of each identity it has
  recorded. The occurrences beyond that count are treated as new, and as messages of
  the run whose `agent_end` delivered the snapshot. For an admitted run they are
  considered for capture. When the run does not capture (the host reported
  `success: false`; the run was retired or aborted, carried no run id, or its agent is
  not served; no usable signing key; the run map full), the scan records the ones it
  identifies as skipped, with a log line. A capture whose write fails is dropped,
  logged, and recorded as skipped, with no retry scheduled. Scans of one session run
  one at a time, and an admitted run whose `agent_end` succeeded is not retired while
  its scan waits.

  Limits: capture is best effort, because the host has no committed-message event and
  no message id. An earlier message that the host rewrites gets a new identity and may
  be captured under the later run whose snapshot first holds the rewritten form.
  Messages with equal role, JSON content and stringified timestamp share one identity
  (a numeric timestamp `1` and a string timestamp `"1"` stringify alike), as can two
  messages through a 64-bit digest collision; when a snapshot holds fewer such copies
  than were recorded (as after a compaction), no copy is captured. A callback without
  a session id records no identity and is not correlated with any other, so its
  messages, including any whose content JSON cannot represent, are considered as new.
  A callback that finds `sessionScanQueueCap` scans queued or running for its session
  records nothing and disables that session's `agent_end` capture (logged once while
  the log key is retained); `llm_input` and `llm_output` capture is unaffected. The
  session map holds `sessionStateCap` sessions, exceeded only while more sessions than
  that have a scan in flight, and each session keeps at most `sessionMessageCap`
  identities. An evicted session or identity is forgotten, so a later run can capture
  its messages again.
