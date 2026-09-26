- **Delete operations send the `hash_values` list Harper requires, so expired pairing tokens are actually removed.**

  Harper's delete schema requires `hash_values` (a list; `ids` is the equivalent
  alias) and refuses a singular `hash_value` with a 400. The cleanup sweep's
  expired-token delete used the singular form, so the record was never actually
  deleted: every tick retried the refused call and logged the same error. The new
  `flair federation instance prune` deletes rows with the list form, confirmed
  against a live Harper.

  > **Heads-up:** two rollback deletes in `flair federation token` — the two that
  > undo the `PairingToken` insert when the bootstrap (`add_user`) fails, on the
  > network path and on the non-OK path — still send the singular key, and their
  > failure is swallowed, so the row they were meant to remove survives. Neither
  > is fixed here (flair#1895).
