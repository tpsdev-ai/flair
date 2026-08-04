- **The refusal to boot against a newer engine's data now runs on every boot path.** `flair start`
  refuses when the data directory was written by a newer Harper — but that check had exactly one call
  site, inline in `start`'s own action. `flair restart` goes straight to `restartFlair` →
  `startFlairProcess` and never reached it, `flair upgrade` restarts by spawning the newly installed
  CLI with `restart`, and the snapshot paths took the same unguarded route.

  So the guard covered one of the doors a boot comes through, and not the one an **engine swap**
  arrives by. Upgrading across a storage-format boundary left the instance down with a bare exit 1,
  and the only explanation surfaced minutes later from the storage layer as an error about
  compression internals — nowhere near the cause, and naming no remedy:

  ```
  the instance is REACHABLE after the upgrade   Expected: >= 200   Received: 0
  the upgrade reported success                  Expected: 0        Received: 1
  ```

  The check is now a single function called from the top of `startFlairProcess`, before anything is
  spawned or launchd is touched, which covers its callers — restart, upgrade and the snapshot paths
  — in one place, plus `start`, which performs its own spawn and keeps its own framing and exit
  code. Deliberately one function rather than a second copy: these two sites had already drifted once
  on the spawn environment, where `start` set a host-qualified ops port and `startFlairProcess` set
  none, silently re-widening the ops API on every restart.

  **`flair restart` and `flair upgrade` now refuse rather than attempt the boot**, and the refusal
  names the restore-from-backup path. An install whose engine version cannot be read is unaffected,
  as before.

  Tests assert the wiring rather than the logic, which was already covered: the decision has exactly
  one implementation in the CLI, the guard precedes the first spawn, and a future boot path that
  bypasses `startFlairProcess` fails the check rather than passing unnoticed.
