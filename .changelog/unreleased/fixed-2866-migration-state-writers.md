- **A migration state write requires a live handle for the state file's migration lock.**

  The writer accepts only the handle returned by a successful migration-lock
  acquisition and refuses a forged object, a released handle or a handle for a
  different lock path with a named error. A lock held by a live process on the
  same host is no longer broken by age, so a second local runner is refused
  while the holder runs; a dead local holder's lock is still broken. Releasing
  a lock removes the lock file only when it still records that holder. A holder
  recorded on another host is still judged by age, so the cross-host case keeps
  the takeover window (single-host guard, #2866).
