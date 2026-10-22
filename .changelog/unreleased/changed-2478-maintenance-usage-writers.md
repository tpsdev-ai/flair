- **The maintenance archive/expiry action and the usage-count bump take the per-id Memory lock shared with owner PUT and PATCH.**

  `POST /MemoryMaintenance` takes the id's lock, once and without waiting,
  around each row's archive/expiry action. An archived row is written as an
  incremental update of `archived` and `archivedAt`; an expired row is
  deleted with its pointer and deletion-history rows in one owned
  transaction. The action decides on the committed row read under the lock,
  commits before releasing, and re-reads the committed row afterwards: an
  archive whose staged fields are not on that row is reported as skipped, and
  a delete whose row is still there is reported as skipped.

  A usage contribution (POST /RecordUsage and citation-on-write) takes the
  memory id's lock before the usage-ledger lock, so the count bump's
  read-modify-write runs on a row no owner write can change under it. The
  count bump writes `usageCount` and the helper's commit marker.

  A run or contribution that cannot take the lock — a held id, an id whose
  last write's outcome is unresolved, or a store with no lock — writes
  nothing for that row and reports it: maintenance counts it in `skipped`,
  and the usage writer logs the skip. A skipped usage contribution is not
  credited, so the memory's count can undercount by that contribution.
