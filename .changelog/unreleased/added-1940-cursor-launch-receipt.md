- **The Cursor wake runner attempts a launch receipt per handoff; the ack follows a successful write, a verified existing receipt, or a classified refusal (flair#1940).**

  After a dispatch is handed to a Cursor Cloud Agent ("created" or "already"),
  the runner attempts one memory as its own agent: a stable id derived from the
  OrgEvent id, content naming only the dispatch id and the launched Cursor agent
  id, and `hostSource` `{ host: "cursor", kind: "launch", id, url? }`. The `id`
  is the Cursor agent id: on create, the id Cursor returned (the requested id
  when the response carries none); on a 409 replay, the requested id, which
  Cursor reported as already in use. The `url` is set only on create, and only
  as Cursor returned it (an `already` result that carries a url never writes one,
  so a replay cannot rewrite the create's stored url). Neither is derived from
  the dispatch text; the write is
  private and omits `hostSourceScope`, so the pointer stays author-only. Only a
  live run signed with the agent's own key writes the receipt, and that signing
  requirement is enforced WHERE THE WRITE HAPPENS: the production receipt store
  requires the key, and the client fails closed (no admin Basic fallback) when
  none resolves at send time; a key the client already loaded is cached and still
  signs, so removing the key file cannot cause a Basic fallback. The store signs
  as exactly the runner's agent: it is bound to the runner's id and a client
  whose signing identity differs is refused. When the memory is
  selected for bootstrap, bootstrap prose cites the pointer to the author as
  `[via cursor/launch <id8> (unverified)]`, and shows `[via withheld]` only to a
  non-author who can read the record after its visibility changes — an ordinary
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
  refusal (400, 409, 413 or 422): the event is acked without its receipt and
  reported as `receiptRefused` with the status and the error code, when present.
  Any other failed write leaves the event unacknowledged for the next cycle and
  is reported as `receiptFailed`; none is a crash. A `hostSource` value the
  server's grammar would refuse (checked on its NFC form, as the server checks
  it) is omitted with one line through the supplied `log` callback — the receipt
  still lands if the remaining write succeeds.
