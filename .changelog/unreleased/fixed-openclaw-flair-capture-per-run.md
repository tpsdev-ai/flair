- **Auto-capture state is now per run; a retired or aborted run admits no new write.**

  Capture state is keyed by agent **and run id** (a callback whose hook carries
  no run id is refused with a one-time log), so two concurrent runs of one agent
  no longer share a budget or a dedup set. The excerpt and the cap slot are
  reserved synchronously before any `await`, so a concurrent callback or the
  `agent_end` rescan dedups against the reservation instead of writing twice;
  the reservation is released if the write fails. A successful `agent_end` ends
  a run without deleting its state (`agent_end` can arrive before `llm_output`
  for the same run); the state retires only once the run has ended with no
  in-flight writes and 30 s have passed, and a run that has seen no `agent_end`
  retires after 30 min idle. Retired and aborted run ids go into a bounded
  tombstone, consulted first, so a late callback is dropped with a one-time log
  naming the run and can never recreate it and capture again. One sweep
  evaluates every run on each callback and on an unref'd interval timer (cleared
  on `gateway_stop`); it caps the live-state map, the tombstone and the
  one-time-log set, evicting the oldest and logging each state eviction with the
  run id. The plugin owns one `AbortController` per run: a failed `agent_end`,
  `gateway_stop`, or a `model_call_ended` with `failureKind: "aborted"` aborts
  it. On abort the run's signal reaches every in-flight capture fetch, **no new
  capture write starts**, a result that resolves after the abort is discarded,
  and reservations are released — this cannot undo a write Flair has already
  received, so a request already in flight may still land.

  (Refs #1751)
