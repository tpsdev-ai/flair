- **A migration state write requires a live handle for the state file's migration lock.**

  The writer accepts only the handle returned by a successful migration-lock
  acquisition, read from module-private identity, and refuses a forged object,
  a released handle, a handle for a different lock path, or a lock file that no
  longer holds that handle, with a named error. A lock is published by writing
  the complete holder record to a temporary file and hard-linking it into
  place, so a contender reads either no lock or a complete record. A holder
  record that cannot be read or parsed is not treated as stale. A live local
  holder is not displaced by age, and a dead local holder's lock is reclaimed
  only when the reclaimer still sees the same device, inode and holder record
  after moving it aside. A holder recorded on another host is still judged by
  age (single-host guard, #2866).
