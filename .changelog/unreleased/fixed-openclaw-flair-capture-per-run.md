- **Auto-capture state is now per run; an aborted run is dropped and never writes.**

  Capture state is keyed by agent **and run id** (a callback whose hook carries
  no run id is refused with a one-time log), so two concurrent runs of one agent
  no longer share a budget or a dedup set. The excerpt and the cap slot are
  reserved synchronously before any `await`, so a concurrent callback or the
  `agent_end` rescan dedups against the reservation instead of writing twice;
  the reservation is released if the write fails. A successful `agent_end` ends
  a run without deleting its state (`agent_end` can arrive before `llm_output`
  for the same run); the state retires only once the run has ended with no
  in-flight writes and 30 s have passed, and a callback for a retired run is
  dropped with a one-time log naming it. The plugin owns one `AbortController`
  per run: a failed `agent_end`, `gateway_stop`, or a `model_call_ended` with
  `failureKind: "aborted"` aborts it — the signal reaches every in-flight
  capture fetch (via a new optional `signal` on `@tpsdev-ai/flair-client`), a
  result that resolves after the abort is discarded, reservations are released,
  and the run is retired immediately.

  (Refs #1751)
