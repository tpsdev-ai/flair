- **The `_reindex` re-PUT and federation merge writes check the stored row again before commit.**

  `Memory.put`'s administrator `_reindex` re-PUT, and the federation sync
  merge of `Soul`, `Agent`, `Relationship` and `Message`, now re-read the
  stored row during the write's transaction. A missing row or identity change
  (`instanceToken`, `contentHash`, `createdAt` or `agentId`) seen by either
  confirmation read refuses the `_reindex` re-PUT with 409 `stored_row_changed`
  or skips a planned `Memory` merge write as `merge_target_changed`.
  `Soul`, `Agent`, `Relationship` and `Message` carry no incarnation token. `Message` has a
  content hash but no `agentId`; its hash excludes mutable lifecycle fields.
  These tables' planned writes compare the whole stored row against the row
  the merge read, refusing changes even when the identity fields match.
  The `Agent` status guard (flair#2108) can skip as
  `agent_status_not_federated` before this comparison. That guard and the `Message`
  consumed-state reconcile (flair#1521) use the in-transaction row. This
  extends flair#2441's Memory-only merge confirmation to every synced table.

  A change committed **after** the final confirm read and before the
  transaction commits is not seen: Harper has no compare-and-set on a table
  write, so the confirmation narrows the window, it does not close it
  (resources/write-back.ts).

  A refused record is excluded once the spoke's cursor reaches its selection
  timestamp. The sender's outbound cursor
  (`peer.lastSyncAt`) is updated by `stampLocalContact`, called once after all
  table queries and batch sends complete for a run with batches. The field-only update
  writes the pre-query timestamp only to a matched row.
  A later batch failure prevents this run's stamp. An unmatched update confirms
  no advance; a deleted Peer row may need restoring before sync can find the hub.
  Selection uses `updatedAt > cursor`, plus legacy null-`updatedAt` rows with
  `createdAt > cursor`; a missing cursor defaults to the epoch.
