- **A capture whose run id is within the server's grammar keeps it as an unverified host source (flair#1940).**

  The OpenClaw capture path writes `hostSource` `{ host: "openclaw", kind: "run",
  id: <run id> }` — the host's run id as sent (Flair stores its NFC form), never derived from
  captured text —
  along with the host's session id when the hook carries one. A run id outside
  the grammar is omitted with one log line; the capture still lands. `hostSource`
  is the writer's claim, not verified host authorship. Writes outside the
  capture path are unchanged.
