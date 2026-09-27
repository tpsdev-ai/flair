- **OpenClaw auto-capture uses one bounded run map for capture state, retention and abort handling.**

  Auto-capture is off by default and requires `autoCapture: true` plus the
  host's `hooks.allowConversationAccess: true`. Recall is separate: when enabled
  and permitted by `hooks.allowPromptInjection`, it can still make a bootstrap
  read with capture disabled.

  Capture records are keyed by agent and run ID, with separate capture counts
  and excerpt-deduplication sets per run. Capture requires a host agent identity
  and a run ID. Entity scanning precedes the synchronous reservation of the
  excerpt hash and capture-count slot; a failed write releases that reservation.

  An accepted successful `agent_end` marks the record ended and leaves it
  eligible for capture until retirement. Sweeps retire ended records once
  30 seconds have elapsed since their latest accepted `agent_end` and no write
  is in flight; live records retire after 30 minutes idle.
  During operation, removal requires a retired or aborted record, no write
  in flight, and at least one hour since retirement or abort. Callbacks for
  retained retired or aborted records are refused.

  Ordinary admission purges removable records and refuses a new run at
  10,000 records (`capture-capacity: full`). Retiring or aborting an existing
  record changes it in place. While active, an abort for an unrecorded run
  purges removable records and can use up to 1,000 additional slots; at that
  limit it records nothing and logs `capture-capacity: abort-overflow`.
  During shutdown, an abort for an unknown run records nothing and logs a
  refusal. While active, callbacks can be admitted again after their record
  is removed, and an unrecorded abort does not prevent later admission when
  capacity is available.

  A failed `agent_end` or `model_call_ended` with `failureKind: "aborted"`
  aborts a recorded run's controller. In-flight capture requests receive that
  signal, and results arriving after abort release their reservations without
  counting as captures; requests already received by Flair may still be stored.
  `gateway_stop` stops admission, clears the sweep timer, aborts recorded runs
  and clears the map; that stopped registration starts no new capture writes.

  (Refs #1751, #1892)
