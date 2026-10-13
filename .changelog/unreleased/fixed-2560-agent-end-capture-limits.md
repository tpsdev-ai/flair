- **`openclaw-flair` never forgets a message a session's `agent_end` snapshot still holds, and spends a run's capture cap on its newest messages (#2560).**

  A session-keyed `agent_end` scan never evicts an identity its current snapshot
  holds, so a session keeps at most max(4,096 (`sessionMessageCap`), the number
  of distinct messages in its latest snapshot) identities and a long session
  does not capture its earlier messages again. The scan runs newest first, so
  the run's cap (`autoCaptureMaxPerSession`) is spent on the run's own newest
  messages; a message the cap leaves out stays unseen until a later run captures
  it, under that run's id. The plugin infers nothing from message timestamps:
  the host gives a snapshot message no host-owned id or position. The remaining
  limit is a session's first scan in the process (a new session, session state
  evicted past `sessionStateCap`, or a gateway restart): it captures at most the
  run's cap of the newest eligible messages and records the rest as seen, so a
  message captured before can land as a second row. Flair's near-duplicate check
  can flag that write `deduplicated` and does not suppress it; the plugin logs a
  counted line at the 1st, 2nd, 4th, … flagged capture. The overflow wording is
  qualified by the state the plugin retains: a queue-overflow disable lasts
  while the session's state is held, and "logged once" means one line per
  retained log key (log keys are a separate set, bounded by `logOnceCap`).
