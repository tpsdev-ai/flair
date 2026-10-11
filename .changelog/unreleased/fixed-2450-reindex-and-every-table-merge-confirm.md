- **The `_reindex` re-PUT and the federation merge of every synced table confirm, inside their write, that the stored row is still the one they read.**

  `Memory.put`'s administrator `_reindex` re-PUT, and the federation sync
  merge of `Soul`, `Agent`, `Relationship` and `Message`, now re-read the
  stored row inside the write's own transaction and write nothing when it is no
  longer the row they read. For the `_reindex` re-PUT and the `Memory` merge the
  stored row is confirmed against the row they read when its identity —
  `instanceToken`, `contentHash`, `createdAt` or `agentId` — changed, or the row
  is gone (a delete or a purge): the re-PUT answers 409 `stored_row_changed`, the
  merge skips the record as `merge_target_changed`. `Soul`, `Agent`,
  `Relationship` and `Message` carry no incarnation token or content hash, so
  their planned writes compare the whole stored row against the row the merge
  read. A same-id replace that keeps the identity fields and changes only a
  data value is refused too. The `Agent` status guard (flair#2108) can skip as
  `agent_status_not_federated` before this comparison. That guard and the `Message`
  consumed-state reconcile (flair#1521) use the in-transaction row. This
  extends flair#2441's Memory-only merge confirmation to every synced table.

  A change committed **after** the final confirm read and before the
  transaction commits is not seen: Harper has no compare-and-set on a table
  write, so the confirmation narrows the window, it does not close it
  (resources/write-back.ts).

  A `merge_target_changed` skip is not re-offered once the spoke's cursor has
  advanced past the record's `updatedAt`. The sender's outbound cursor
  (`peer.lastSyncAt`) is updated by `stampLocalContact`, called once after every
  batch got a successful (2xx) response with valid JSON. The field-only update
  advances the cursor to the pre-query timestamp only if it matches the row.
  A later batch failure or an unmatched update leaves the old cursor, so the
  next sync can re-offer the refused record with unchanged `updatedAt`. Once the
  cursor passes that value, selection excludes it. A row with
  `updatedAt > cursor` can be selected again.
