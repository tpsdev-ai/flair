- **The Cursor wake runner attempts a launch receipt per handoff; the ack follows a successful write, a verified existing receipt, or a classified refusal (flair#1940).**

  After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
  the runner attempts one memory as its own agent: a stable id derived from the
  OrgEvent id, content naming only the dispatch id and the launched Cursor agent
  id, and — when the Cursor agent id passes the server's host-source grammar —
  `hostSource` `{ host: "cursor", kind: "launch", id, url? }` claiming where the
  launch lives. The receipt is "sourced" only when that pointer was STORED: an id
  the grammar refuses stores no pointer (an unsourced receipt, no host-source
  citation), and a read or write failure can prevent the receipt entirely. The `id`
  is the Cursor agent id: on create, the id Cursor returned (the requested id
  when the response has no string id); on a 409 classified as an agent-id
  conflict, the requested id. The `url` is set only on create, and only
  as Cursor returned it (an `already` result that carries a url never writes one,
  so a serialized replay that reads the existing receipt cannot rewrite the
  create's stored url — the two-runner race is disclosed, not claimed away).
  Neither is derived from
  the dispatch text; the write is
  private by default for a new receipt and omits `hostSourceScope`, so its bound pointer is author-only. Only a
  live run signed with the agent's own key writes the receipt, and that signing
  requirement is enforced at the START of the exported runner — `runWakeCycle`
  LOADS AND VALIDATES the agent's Ed25519 key into the client and LOCKS it to
  signed-only, by name, before it reads the feed or launches Cursor, so every
  FlairClient request in the cycle is signed with that loaded key (an unparsable or non-Ed25519
  key file is refused there, by name) — and again WHERE THE WRITE HAPPENS: the
  production receipt store requires the key, and the client fails closed (no admin
  Basic fallback) when none resolves at send time; the loaded key is cached and
  still signs, so removing the key file cannot cause a Basic fallback. Admin Basic
  credentials are accepted only for the `--dry-run` mode, which performs no Cursor
  create, no receipt write and no ack; its catchup read may create an
  `AgentReadPosition`. Cursor launches use Cursor API Basic authentication with
  `CURSOR_API_KEY`. A live cycle uses one signed Flair client for catchup and
  receipts; the exported cycle takes no separate agent id or receipt store.
  The Cursor client is selected from
  `--dry-run` and the Cursor config, not built from the Flair client (a dry-run
  cycle performs no Cursor create, receipt write or ack). When an active memory
  with a bound pointer is selected for bootstrap, bootstrap prose cites that pointer to the author as
  `[via cursor/launch <id8> (unverified)]`, and shows `[via withheld]` only to a
  non-author who can read the active record with a bound pointer after its visibility changes — an ordinary
  non-author cannot read this private row at all, and an admin can read it but
  takes no pointer join — flair#2446. A receipt already present under
  that id is left unchanged only when it VERIFIES as this runner's own receipt
  (same author, content and host-source identity — the id compared on its NFC
  form, the form the server stores), so a replay that reuses the
  agent (Cursor 409) retries the receipt without rewriting the one already
  stored; a row that fails that check is not verified as this runner's receipt:
  it is reported as `receiptMismatched`, left untouched, and not acked (a
  foreign PRIVATE row reads as absent to the runner, so the runner attempts the
  write and the server refuses it instead). The ack follows a successful write
  or a verified existing receipt — except for a receipt the runner treats as a
  non-retryable
  refusal (400, 409, 413 or 422): the event is ackable without its receipt and
  reported as `receiptRefused` with the status and an error token, when present.
  Skipped events are ackable without a launch or receipt; a later failure can
  still ack earlier successful or skipped events. Any other failed write leaves
  that event unacknowledged for the next cycle and
  is reported as `receiptFailed`. An invalid id omits the pointer; an invalid
  url omits only the url. Omissions are logged through the supplied callback.
  Read or write failure can still prevent the receipt.
