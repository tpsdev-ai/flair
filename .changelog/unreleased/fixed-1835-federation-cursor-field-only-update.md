- **The federation sync cursor advances on a legacy hub row, and a field-only write can no longer revert a key repair or revocation.**

  `flair federation sync` stamps `lastSyncAt` after a successful sync batch or
  the no-change liveness ping. That value is the spoke's outbound cursor (sync
  re-sends from it) and the contact stamp behind `connected`. The previous write
  read the local hub `Peer` row and re-upserted it whole, gated on a non-empty
  `publicKey` — so a legacy pairing (key recorded as empty) refused on every
  poll, the cursor froze, and the hub dashboard went stale. The write is now a
  field-only `update` of `{id, lastSyncAt, updatedAt}`: it carries no
  `publicKey`/`status`, so it cannot revert a concurrent key repair or
  revocation; it never inserts a missing row, and it refuses (naming the remedy)
  when the update matches no row.

  > **Heads-up:** a legacy spoke whose hub row has an empty `publicKey` no longer
  > warns every poll — its cursor advances again. The missing key itself is not
  > repaired here; re-pair the hub to restore it. `connected` means recent
  > contact, not a verified identity or pull readiness.

  (Closes #1835)
