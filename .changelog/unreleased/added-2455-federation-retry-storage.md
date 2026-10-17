- **Sealed FederationRetry storage and an administrator-only HTTP reader support retry bookkeeping (#2538).**

  The `flair federation status` command includes a retry section.

  The table is shaped for one row per (peer, table, record) a receiver refuses
  for a reason a later re-offer could clear. No production sender path creates
  rows yet; sender activation is deferred to a later slice. Rows an admin
  writes are readable now. Sealed means a write naming a field the schema does
  not declare is refused. The reader lists a row that breaks the sender's
  conventions (an id that is not its tuple's key, an unknown state, reason or
  outcome) as malformed, never as pending. The table is excluded from
  federation policy and the receive mapping, so an inbound sync naming it is
  refused. Every emitted skip reason is now typed as the closed `SkipReason`
  union, with an exhaustive classification a future reason must join.
