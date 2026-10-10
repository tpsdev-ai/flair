- **The Cursor wake runner records a sourced launch receipt for each handoff (flair#1940).**

  After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
  the runner writes one memory as its own agent: a stable id derived from the
  OrgEvent id, content naming only the dispatch id and the launched Cursor agent
  id, and `hostSource` `{ host: "cursor", kind: "launch", id, url? }`. The `id`
  is the Cursor agent id: on create, the id Cursor returned (the requested id
  when the response carries none); on a 409 replay, the requested id, which
  Cursor reported as already in use. The `url` is set only on create, and only
  as Cursor returned it. Neither is derived from the dispatch text. A receipt
  already present under that id is left unchanged, so a replay that reuses the
  agent (Cursor 409) retries the receipt without rewriting the one already
  stored. The write precedes the watermark ack. A write the server refuses
  outright (400, 409, 413 or 422) is not retried: the event is acked without its
  receipt and reported as `receiptRefused` with the status and the server's
  error code. Any other failed write leaves the event unacknowledged for the next
  cycle and is reported as `receiptFailed`; neither is a crash. A `hostSource`
  value the server's grammar would refuse (checked on its NFC form, as the
  server checks it) is omitted with one log line — the receipt still lands.
