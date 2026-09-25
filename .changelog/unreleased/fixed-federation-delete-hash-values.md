- **Delete operations send the `hash_values` list Harper requires, so expired pairing tokens are actually removed.**

  Harper's delete schema requires `hash_values` (a list; `ids` is the equivalent
  alias) and refuses a singular `hash_value` with a 400. The cleanup sweep's
  expired-token delete used the singular form, so the record was never actually
  deleted: every tick retried the refused call and logged the same error. The new
  `flair federation instance prune` deletes rows with the list form, confirmed
  against a live Harper.

  > **Heads-up:** two call sites outside this change — `flair federation token`'s
  > rollback delete and its explicit token delete — still send the singular key.
