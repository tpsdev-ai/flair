- **The Cursor wake runner attempts a launch receipt per handoff; the ack follows a successful write, a verified existing receipt, or a classified refusal (flair#1940).**

  After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
  the runner attempts one memory as its own agent: a stable id derived from the
  OrgEvent id, content naming only the dispatch id and the launched Cursor agent
  id, and — when the Cursor agent id passes the server's host-source grammar —
  `hostSource` `{ host: "cursor", kind: "launch", id, url? }` claiming where the
  launch lives. The receipt is "sourced" only when that pointer was STORED: an
  id the grammar refuses stores no pointer (an unsourced receipt, no host-source
  citation), and a read or write failure can prevent the receipt entirely. The
  `id` is the Cursor agent id: on create, the id Cursor returned (the requested
  id when the response has no string id); on a 409 classified as an agent-id
  conflict, the requested id. When the Cursor agent id and URL pass validation,
  a create response adds the URL to the source pointer; a verified existing
  receipt is left unchanged. Neither is derived from the dispatch text; the
  write is private by default for a new receipt and omits `hostSourceScope`, so
  its bound pointer is author-only. Live cycles validate a private Ed25519 key
  before reading the feed and require signed Flair requests throughout; missing
  or unusable signing credentials stop the cycle. Admin Basic credentials are
  accepted only for the `--dry-run` mode, which performs no Cursor create, no
  receipt write and no ack; its catchup read may create an `AgentReadPosition`.
  Cursor launches use Cursor API Basic authentication with `CURSOR_API_KEY`. A
  live cycle uses one signed Flair client for catchup and receipts; the exported
  cycle takes no separate agent id or receipt store. The Cursor client is
  selected from `--dry-run` and the Cursor config, not built from the Flair
  client (a dry-run cycle performs no Cursor create, receipt write or ack). When
  an active memory with a bound pointer is selected for bootstrap, bootstrap
  prose cites that pointer to the author as `[via cursor/launch <id8>
  (unverified)]`, and shows `[via withheld]` only to a non-author who can read
  the active record with a bound pointer after its visibility changes — an
  ordinary non-author cannot read this private row at all, and an admin can read
  it but takes no pointer join — flair#2446. An existing readable receipt is
  left unchanged only when its author, content, and host-source identity match.
  A readable mismatch is reported as `receiptMismatched`, left untouched, and
  not acknowledged. The ack follows a successful write or a verified existing
  receipt — except for a receipt the runner treats as a non-retryable refusal
  (400, 409, 413 or 422): the event is ackable without its receipt and reported
  as `receiptRefused` with the status and an error token, when present. Skipped
  events are ackable without a launch or receipt; a later failure can still ack
  earlier successful or skipped events. Any other failed write leaves that event
  unacknowledged and is reported as `receiptFailed`; it can be retried if
  another cycle runs. `--once` schedules no retry. An invalid id omits the
  pointer; when the id is valid, an invalid URL omits only the URL. Omissions
  are logged through the supplied callback. Read or write failure can still
  prevent the receipt.
