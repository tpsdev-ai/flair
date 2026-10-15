- **`openclaw-flair` stops re-capturing earlier messages a session's snapshot still holds, while it keeps that session's state, and spends a run's cap from the end (#2560).**

  While the plugin holds a session's state, a session-keyed `agent_end` scan's
  identity cap never evicts a recorded identity the current snapshot holds, so
  recorded identities number at most max(4,096 (`sessionMessageCap`), D), D
  being the distinct identities in the last snapshot accounted for (disabled
  callbacks do not update it), and a recorded message that stays in the snapshot
  is not offered again. Deferred identities (below) hold only that snapshot's
  identities, so at most D. The scan walks the snapshot from its last position,
  so the run's cap
  (`autoCaptureMaxPerSession`) is spent on the last eligible positions. In a
  warm session a message the cap leaves out stays eligible for a later capture
  scan unless settled, subject to its gates and cap; another cap can leave it unseen.
  A refused scan settles its occurrences, including identical copies: their
  origin is ambiguous. Preserving deferred messages while excluding refused-run
  copies fully needs a stable host-owned message identity; that is a follow-up.
  Same-run excerpt dedup, a failure before the write, a failed write, or a
  write whose run is aborted while it is in flight settles it. Message identity now encodes
  the timestamp's type, and the plugin infers nothing from timestamps: the host
  gives a snapshot message no host-owned id or position. The remaining limit is
  a session's first scan in the process (a new session, session state evicted
  past `sessionStateCap`, or a gateway restart): it offers the last eligible
  positions up to the run's cap and records the rest of the identifiable
  messages as seen, so a message captured before can be captured again, if it
  passes the capture rules and its write succeeds, as a second row under the
  current run's id. Flair's near-duplicate check can flag that write
  `deduplicated` and does not suppress it; the plugin logs a counted line at the
  1st, 2nd, 4th, … flagged capture: none for n = 0, and floor(log2 n) + 1 lines
  for n ≥ 1. The overflow wording is qualified by the state the plugin retains:
  a queue-overflow disable lasts while the session's state is held, and "logged
  once" means one line per retained log key (log keys are a separate set,
  bounded by `logOnceCap`).
