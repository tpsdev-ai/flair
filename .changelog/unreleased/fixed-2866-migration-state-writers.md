- **A migration state write requires a live handle for the state file's migration lock.**

  The writer accepts only the handle returned by a successful migration-lock
  acquisition, read from module-private identity, and refuses a forged object,
  a released handle, a handle for a different lock path, or a lock file that no
  longer holds that handle, with a named error. Lock-file acquisition,
  replacement and release are serialized by a directory mutex published as a
  populated directory; a dead mutex generation is recovered by unlinking only
  its owner entry, and the recovering process must then win publication of its
  own directory. A complete holder record is published by hard link, and a dead
  local holder's record is replaced with an atomic rename. A record that cannot
  be read or parsed is not treated as stale. A live local holder is not
  displaced by age; a holder recorded on another host is still judged by age
  (single-host guard, #2866).
