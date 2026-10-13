- **A sender-owned `FederationRetry` table records federation retry obligations; an admin-only reader and `flair federation status` show them.**

  The table holds one row per (peer, table, record) the receiver refused for a
  reason a later re-offer could clear; it stores no record content and is
  excluded from federation policy and the receive mapping, so an inbound sync
  naming it is refused. Every emitted skip reason is now typed as the closed
  `SkipReason` union, with an exhaustive classification a future reason must
  join. Nothing sends retries yet.
