- **When the engine stamp is present, an older flair that ships the backwards-engine guard refuses before that Harper opens the data directory (flair#1047).**

  Harper 5.3's RocksDB storage format is one-way: a build older than 5.3 reads
  tables created under 5.3 as empty, so an older flair **cannot safely read or
  serve data written by this release**. Started against such a store, an older
  flair otherwise reached Harper's installer, which refused — but modified
  database files first. This release's instance component attempts to write
  `~/.flair/data/engine-version.txt` at boot; the write is best effort. When
  the stamp is present, `flair start`'s backwards-engine guard — in a release
  that carries it — refuses an older engine *before* any Harper process is
  spawned, naming both versions and the data directory. Without a readable
  stamp, or in a build that predates the guard, there is no refusal.
  To downgrade across this boundary, restore the pre-upgrade snapshot
  (`flair snapshot restore <path>`) or a `flair backup` export taken on the
  older version.
