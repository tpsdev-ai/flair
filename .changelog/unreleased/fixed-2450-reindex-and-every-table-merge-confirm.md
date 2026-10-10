- **The `_reindex` re-PUT and the federation merge of every synced table confirm, inside their write, that the stored row is still the one they read.**

  `Memory.put`'s administrator `_reindex` re-PUT, and the federation sync
  merge of `Soul`, `Agent`, `Relationship` and `Message`, now re-read the
  stored row inside the write's own transaction and write nothing when it is no
  longer the row they read — a delete, a purge or a same-id replace committed
  between the read and the write is neither undone nor overwritten. The re-PUT
  answers 409 `stored_row_changed`; the merge skips the record as
  `merge_target_changed`. The `Agent` status guard (flair#2108) and the
  `Message` consumed-state reconcile (flair#1521) now key on that confirmed row.
  This extends flair#2441's Memory-only merge confirmation to every synced
  table.

  A `merge_target_changed` skip is **dropped, not re-offered**: the receiver
  keeps no per-record retry state, and the spoke's outbound cursor
  (`peer.lastSyncAt`) advances past the refused record after any successful
  batch, so the next `federation sync` — which selects rows by
  `updatedAt > cursor` — cannot resend it. Only a further change to the sender's
  own row (a new `updatedAt`) sends it again.
