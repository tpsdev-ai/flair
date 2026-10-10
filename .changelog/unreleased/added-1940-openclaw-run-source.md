- **A captured memory keeps the host run id as an unverified host source (flair#1940).**

  When the host run id is within the server's `hostSource` id grammar, the
  OpenClaw capture path writes it as `hostSource` `{ host: "openclaw", kind:
  "run", id: <run id> }` — the run id verbatim, never derived from captured text
  — along with the host's session id when the hook carries one. A run id outside
  that grammar is omitted with one log line; the capture still lands.
  `hostSource` is the writer's claim, not verified host authorship. Writes
  outside the capture path are unchanged.
