- **Downgrade refusal is conditional (flair#1047).**

  This release's instance component attempts to write
  `engine-version.txt` in `ROOTPATH` (or `~/.flair/data` when unset) at boot; the write is best effort.
  With a readable, nonempty stamp and a known installed Harper version, an older guarded Flair refuses before Harper opens the store if the stamp is newer or the versions cannot be compared. A failed write can leave a stale stamp.
  The only full rollback is restoring the pre-upgrade physical data-directory
  snapshot (`flair snapshot restore <path>`). `flair backup`/`restore` logically
  exports/imports only Agent, Memory and Soul rows through a running server; it
  can transfer those rows into a fresh compatible instance.
