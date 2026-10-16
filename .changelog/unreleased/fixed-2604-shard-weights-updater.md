- **The integration shard weights updater writes a fresh table from a missing
  or malformed one (#2604).**

  Assignment commands validate the table before any assignment. With usable logs
  and a writable output directory, the updater replaces a missing or malformed
  table. The regeneration test asserts the complete derived weight map for the
  log fixture (#2605).
