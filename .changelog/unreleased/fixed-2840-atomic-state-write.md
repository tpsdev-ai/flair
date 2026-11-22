- **The migration state, snapshot and export files are written atomically.**
  Each is written to a temporary file in its own directory, created with mode
  0600 (the process umask can only remove bits), and renamed into place after the temporary file's data is flushed to disk, so
  once the target exists a concurrent reader sees the old file or the new one,
  never a truncated or half-written one (before the first rename there is no
  file to read). If a step after the temporary file is created fails, the write
  attempts to remove that file and rethrows. Two concurrent writers still race
  with each other, and the last one wins. (#2840)
