- **The integration shard weights updater writes a fresh table from a missing
  or malformed one (#2604).**

  The weights table is read on first use by the shard-assignment commands, not at
  import, so the updater runs whatever state the checked-in table is in. The
  regeneration test asserts the complete derived weight map for the log fixture
  (#2605).
