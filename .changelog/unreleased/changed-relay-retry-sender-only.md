- **A Relay `POST /Message` that reuses a stored message id gets the idempotent answer only when it comes from that message's sender.**
  The stored message is owned by its `from`, and the send's `from` is the verified signer. When
  they match, the send is answered with the stored message's accepted envelope: a retry writes no
  second row and is not charged against the inbox cap again. When they differ, the send is
  refused with `403 {"error":"forbidden: cannot modify Message owned by another principal"}` — the
  same response the auth middleware gives a write to `/Message/<id>` the caller does not own — and
  no field of the stored message is returned. The rule applies to admin senders too. If the stored
  message cannot be read, the send is refused the same way and nothing is written.

  Both refusals are built by one shared constructor (`resources/record-owner-guard.ts`'s
  `ownerMutationRefusal`), so the two routes cannot drift apart.
