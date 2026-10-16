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
  transaction by its first read, so the authoritative row read, the decisions
  drawn from that row and the commit share one transaction (preflight checks,
  such as seed authorization, run under the lock before it opens) (re-embed `PATCH` writes in an inner owned transaction) — a
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

  The critical section contains the write paths' embedding calls — the
  ordinary `PUT`'s regen and its create-path dedup probe, the re-embed `PATCH`'s
  compute and its recompute, and the `PATCH` embedding refresh. Text/vector parity
  is protected against writers serialized by this lock; a change after confirmation
  is not seen. A provider call still pending at the bound or settling after it
  refuses that write 503 `memory_provider_timeout` and writes nothing. An
  observe-only watchdog logs a hold longer than 5 s (lock keys, phase and elapsed time) when its timer runs, or at settlement if the event
  loop cannot resume during the hold. It never releases the lock. The global lock order is:
  a writer takes its sorted Memory id locks first, then the instruction-version
  lock, then the usage ledger; part 2 converts the writers that take the
  instruction lock and write Memory to take their Memory id locks before it.

  A `PUT` that supersedes a target does not yet lock the predecessor's id: the
  grant-authorized close is staged in the successor's transaction, but the
  ordinary supersede close runs after the commit, best-effort, without the
  predecessor's lock. The predecessor id joins the lock set in part 2.

  Client contract: a caller that gets `memory_busy` may resend the same write
  unchanged, within a bounded retry — the refusal wrote nothing. A caller that
  gets `write_outcome_unknown` must read the affected row first and treat a row
  that already holds the write as written, never replaying that write blindly.
