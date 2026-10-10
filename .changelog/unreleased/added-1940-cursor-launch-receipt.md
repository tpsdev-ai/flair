- **The Cursor wake runner records a sourced launch receipt for each handoff (flair#1940).**

  After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
  the runner writes one memory as its own agent: a stable id derived from the
  OrgEvent id, content naming only the dispatch id and the launched Cursor agent
  id, and `hostSource` `{ host: "cursor", kind: "launch", id: <Cursor agent id>,
  url: <Cursor's agent url when it returned one> }` — the id and url Cursor
  returned, not derived from the dispatch text. A receipt already present under
  that id is left unchanged, so a replay that reuses the agent (Cursor 409)
  retries the receipt without rewriting the one already stored. The write
  precedes the watermark ack; a failed write leaves the event unacknowledged and
  is reported as a named outcome, not a crash. A `hostSource` value outside the
  server's grammar is omitted with one log line — the receipt still lands.
