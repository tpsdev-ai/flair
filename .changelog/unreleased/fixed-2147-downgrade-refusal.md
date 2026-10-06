- **Downgrade refusal is conditional (flair#1047).**

  This release's instance component attempts to write
  `~/.flair/data/engine-version.txt` at boot; the write is best effort.
  With a readable stamp and a known installed Harper version, an older guarded Flair refuses before Harper opens the store if the stamp is newer or the versions cannot be compared. A failed write can leave a stale stamp.
  To downgrade across this boundary, restore the pre-upgrade snapshot
  (`flair snapshot restore <path>`) or a `flair backup` export taken on the
  older version.
