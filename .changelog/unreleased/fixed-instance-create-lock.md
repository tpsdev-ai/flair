- **Concurrent first-boot `GET /FederationInstance` requests create exactly one identity row, and every caller is answered with it.**

  The read-mint-write now runs under a Flair-owned filesystem ticket lock
  (`$HOME/.flair/locks/instance-create/`), so it serialises **every HTTP worker of
  one Harper process** — not just one — and separate processes that share the same
  Flair home. `globalThis` is per Harper worker, so an in-process lock could not
  do this; the lock is a claim file per contender (O_EXCL), the holder being the
  smallest live claim and each contender holding only after it stays smallest for a
  poll interval.

  The detached write completes in its own Harper immediate transaction before the
  lock is released — the confirming re-read then sees the row the same request
  wrote, and a re-read that finds NONE is refused rather than answered from the
  local object (the seam this relies on has then failed; the confirmation re-read
  returns the stored row, never the local one).

  `flair init --remote` does not take the lock yet — the CLI writer joining the
  same lock, and a store-enforced one-row invariant, remain desirable (slice 2).

  The 50-round `GET /FederationInstance` race test in `test/integration/` is the
  upgrade tripwire: it runs in the required `Integration Tests` check and goes red
  if a future Harper moves the immediate transaction outside the awaited call.

  (Refs #1897)
