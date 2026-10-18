- **Owned-transaction writers confirm their write after the commit.**

  Agent-key registration, first-time pairing, the re-embed vector refresh, the
  IdP credential touch and the `.content`-suffix migration re-read the committed
  row after their transaction commits. A readable mismatch retries within the
  site's bound, if any; an unreadable verification stops. An unconfirmed
  migration write is uncounted; a later scan decides pending state (#2656).
