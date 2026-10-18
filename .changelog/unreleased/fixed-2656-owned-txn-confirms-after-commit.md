- **Owned-transaction writers confirm their write after the commit.**

  Agent-key registration, first-time pairing, the re-embed vector refresh, the
  IdP credential touch and the `.content`-suffix migration re-read the committed
  row after their transaction commits; a site with a retry bound retries, the
  others answer their named failure, and a write the commit dropped is not
  reported as applied (#2656).
