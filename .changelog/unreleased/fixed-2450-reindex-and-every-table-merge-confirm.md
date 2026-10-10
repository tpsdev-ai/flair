- **The `_reindex` re-PUT and the federation merge of every synced table confirm, inside their write, that the stored row is still the one they read.**

  `Memory.put`'s administrator `_reindex` re-PUT, and the federation sync
  merge of `Soul`, `Agent`, `Relationship` and `Message`, now re-read the
  stored row inside the write's own transaction and write nothing when it is no
  longer the row they read. For the `_reindex` re-PUT and the `Memory` merge the
  stored row is confirmed against the row they read when its identity —
  incarnation token, content hash, creation time or owner — changed, or the row
  is gone (a delete or a purge): the re-PUT answers 409 `stored_row_changed`, the
  merge skips the record as `merge_target_changed`. `Soul`, `Agent`,
  `Relationship` and `Message` carry no incarnation token or content hash, so
  for them the whole stored row is compared against the row the merge read; a
  same-id replace that keeps the identity fields and changes only a data value
  is refused too. The `Agent` status guard (flair#2108) and the `Message`
  consumed-state reconcile (flair#1521) now key on that confirmed row. This
  extends flair#2441's Memory-only merge confirmation to every synced table.

  A change committed **after** the final confirm read and before the
  transaction commits is not seen: Harper has no compare-and-set on a table
  write, so the confirmation narrows the window, it does not close it
  (resources/write-back.ts).

  A `merge_target_changed` skip is **dropped, not re-offered**: the receiver
  keeps no per-record retry state. The sender's outbound cursor
  (`peer.lastSyncAt`) is advanced to the pre-query timestamp — but only once, at
  the end of the whole run, and only when every batch returned 200 and the
  field-only cursor update matched the row. A later batch that fails (or a
  cursor update that does not match) leaves the cursor where it was, so the next
  `federation sync` re-offers every record from the old cursor, the refused one
  included. When the cursor does advance past a refused record, the next poll's
  `updatedAt > cursor` selection cannot pick it up again — because its stored
  `updatedAt` is still what it was (the receiver never rewrites it on a refusal),
  not because `updatedAt` is a structural guarantee: a row whose `updatedAt` is
  bumped by a writer during the run carries `updatedAt > cursor` and is
  re-offered next cycle.
