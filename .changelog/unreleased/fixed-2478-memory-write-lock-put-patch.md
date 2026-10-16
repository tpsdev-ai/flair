- **Memory `PUT`/`PATCH` now lock the target id and commit ordinary row writes in owned transactions (#2478).**

  Both verbs take the per-id memory write lock and run their ordinary write in an
  owned transaction whose FIRST operation is the authoritative stored read, and
  that transaction commits before the lock releases, so two such owner `PUT`/`PATCH`
  writes to the same id cannot interleave. A same-id owner writer waits for the lock
  within its budget, then opens its transaction and reads the row as stored at
  that moment (a manual promotion's write, or an admin `_reindex` re-PUT, that
  joins an already-open request transaction reads that transaction's earlier
  snapshot instead); if an attempt observes an outcome-unknown marker for the id
  it answers 503 `write_outcome_unknown`; if the lock stays held for the whole
  budget it answers 503 `memory_busy`, and if the store has no lock the write is refused 503
  `memory_lock_unavailable` instead of running unserialized. Harper orders a
  transaction by its first read, so the read, the decision and the commit share
  one transaction (re-embed `PATCH` writes in an inner owned transaction) — a
  background field-only write started later therefore folds around this older full update
  instead of being overwritten. After a normal storage result, the ordinary
  owned row write re-reads its id after commit and confirms the committed row
  still carries the incarnation token this write left
  and, among the fields the write declared, the same `agentId`, `content`,
  `visibility` and `durability`. A row deleted and re-created with a different
  token (even with the same values), or one where a later write changed one of
  those four, answers 409 `stored_row_changed`; a later write that changed only
  other fields (not the token) is not refused. Refusals, including storage
  Responses, return before that read; skill `PUT` has no ordinary-row verification, and composed
  promotion uses its in-transaction existence check. A successful re-embed
  `PATCH` checks its token after its inner commit, and a `PATCH` or re-embed of
  a row written before incarnation tokens gives it one in the same write. A verification read
  that fails answers 503 `write_outcome_unknown`. PUT/PATCH check the addressed
  id's marker; DELETE also checks the resolved skill head. Markers clear on
  restart; POST and background/nested writers do not check them. A `PUT` or
  `PATCH` that names no id is refused before the lock helper with 400
  `memory_id_required`. A manual promotion's memory write joins the
  promotion's own transaction, so its approval stamp commits or rolls back with
  the row; that commit lands after the lock releases, as does the admin
  `_reindex` re-PUT's when the request carries an open transaction it joins. The
  lock is per process, and it serializes only owner `PUT`/`PATCH` writes that
  commit under it, within one instance.
