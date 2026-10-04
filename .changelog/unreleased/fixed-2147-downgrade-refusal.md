- **Downgrade refusal is conditional (flair#1047).**

  Harper 5.3's RocksDB storage format is one-way: a build older than 5.3 reads
  tables created under 5.3 as empty, so an older flair **cannot safely read or
  serve data written by this release**. Started against such a store, an older
  flair otherwise reached Harper's installer, which refused — but modified
  database files first. This release's instance component attempts to write
  `~/.flair/data/engine-version.txt` at boot; the write is best effort. When
  an older guarded Flair refuses before Harper opens the store when it finds
  both the engine stamp and its own installed Harper version; otherwise it does
  not refuse.
  To downgrade across this boundary, restore the pre-upgrade snapshot
  (`flair snapshot restore <path>`) or a `flair backup` export taken on the
  older version.
