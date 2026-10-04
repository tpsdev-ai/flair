- **An older flair that ships the backwards-engine guard refuses a data directory this release stamped at `~/.flair/data`, before that Harper opens it (flair#1047).**

  Harper 5.3's RocksDB storage format is one-way: a build older than 5.3 reads
  tables created under 5.3 as empty, so **data written by this release cannot be
  opened by an older flair**. Started against such a store, an older flair
  otherwise reached Harper's installer, which refused — but modified database
  files first. This release's instance component writes
  `~/.flair/data/engine-version.txt` at boot, so `flair start`'s
  backwards-engine guard — in a release that carries it — reads the stamp and
  refuses an older engine *before* any Harper process is spawned, naming both
  versions and the data directory; the refused start leaves the data directory
  byte-identical. The stamp lives only at `~/.flair/data`: a store written
  elsewhere carries none, and a build that predates the guard does not refuse.
  To downgrade across this boundary, restore the pre-upgrade snapshot
  (`flair snapshot restore <path>`) or a `flair backup` export taken on the
  older version.
