- **A sealed, admin-only `FederationRetry` table for federation retry bookkeeping, with an admin-only reader and a retry section in `flair federation status`.**

  The table is shaped for one row per (peer, table, record) a receiver refuses
  for a reason a later re-offer could clear. Nothing writes to it yet: the
  sender starts using it in a later release, so the reader and the status
  section stay empty until then. The table is sealed, so a write carrying a
  field the schema does not declare is refused and no record content can be
  stored. It is excluded from federation policy and the receive mapping, so an
  inbound sync naming it is refused. Every emitted skip reason is now typed as
  the closed `SkipReason` union, with an exhaustive classification a future
  reason must join.
