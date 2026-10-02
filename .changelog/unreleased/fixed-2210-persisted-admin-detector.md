- **The `flair init` persisted-admin detector now reads Harper 5's RocksDB `hdb_user` store, so a current install is no longer read as fresh (Closes #2210).**

  `flair init` and `flair doctor` detected the persisted admin user only in the
  LMDB files (`system/hdb_user/data.mdb` and the legacy `system/hdb_user.mdb`)
  that older data directories keep. Harper 5 stores the whole system schema in a
  RocksDB at `database/system`, where the admin row is a `hdb_user/` column
  family key, so on a current install the detector reported "no persisted user":
  `flair init` took the fresh-install branch, the `persisted-missing-file`
  refusal never fired, and an explicit credential did not re-persist the file.
  The detector now reads the `hdb_user/` store with Harper's own engine (and
  keeps the LMDB paths for older directories); an unreadable system store is
  refused rather than read as "no user".

  Fresh local `flair init` saves an explicit admin credential to
  `~/.flair/admin-pass` (0600) on every platform.
