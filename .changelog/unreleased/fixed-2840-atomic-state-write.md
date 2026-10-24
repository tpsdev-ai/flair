- **The migration state, snapshot and export files are written atomically.**
  Each is written to a temporary file at 0600 in its own directory and renamed
  into place, so once the target exists a concurrent reader sees the old file
  or the new one, never a truncated or half-written one (before the first
  rename there is no file to read). A failed write attempts to remove its
  temporary file and rethrows. Two concurrent writers still race with each
  other, and the last one wins. (#2840)
