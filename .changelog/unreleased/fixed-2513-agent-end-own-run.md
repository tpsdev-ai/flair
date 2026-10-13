- **`agent_end` capture now counts each session's message occurrences, so a session-keyed scan treats only new occurrences as the ending run's (best effort) (#2513).**

  The previous release rescanned the whole session snapshot on every `agent_end`,
  storing an earlier run's messages again under the new run's id. Now, in a scan for
  a callback with a session id, identifiable occurrences beyond the session's recorded
  count are considered for that run's capture, or skipped when its `agent_end` capture
  is refused, and a failed write is dropped with no retry scheduled. The main limit is
  that the host has no message id or committed-message event, so ownership is inferred
  from snapshot diffs: a rewritten earlier message gets a new identity and may be
  captured under a later run, equal-field copies reduced by a compaction are not
  captured, a callback without a session id is not correlated with any other, evicted
  session state is forgotten, and a session whose scan queue overflows stops its
  `agent_end` capture.
