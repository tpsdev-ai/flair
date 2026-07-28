- **`flair federation status` now says whether anything is driving sync.** It previously warned
  "one or more peers haven't merged a record in >24h" identically whether sync was running and the
  peer was unreachable, or nothing had run sync since the day you paired — two problems needing
  opposite fixes, reported the same way. Status now combines the service manager's view of the
  driver with peer contact times and names which one you actually have: driver active and healthy,
  driver active but not reaching the peer, unit files present but never loaded, no driver at all,
  or an unmanaged driver (a cron entry, a hand-written unit) that is working fine. The driver check
  is local to the machine running the CLI, so it is omitted for remote `--target`s rather than
  making a claim about a host it cannot see.
