- **The `flair init` persisted-admin detector now reads Harper 5's RocksDB `hdb_user` store, so a current install is no longer read as fresh (Closes #2210).**

  `flair init` and `flair doctor` now recognize persisted administrator state in
  Harper 5 RocksDB and older supported stores; unreadable state is refused.

  Fresh local `flair init` saves an explicit admin credential to
  `~/.flair/admin-pass` (0600) on every platform.
