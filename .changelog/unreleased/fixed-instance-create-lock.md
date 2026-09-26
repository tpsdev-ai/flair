- **Concurrent first-boot `GET /FederationInstance` requests create exactly one identity row, and every caller is answered with it.**

  The read-mint-write runs under a Flair-owned filesystem bakery lock
  (`$HOME/.flair/locks/instance-create/`), so it serialises **every HTTP worker of
  one Harper process** — not just one — and separate processes that share the same
  Flair home. The holder rule is Lamport's bakery on files: a contender writes a
  complete claim (tmp then atomic rename), takes the next ticket
  (`1 + max visible ticket`), and holds once its ticket is the smallest live one.
  No timing assumption — only atomic create, atomic rename within one directory,
  and live-pid detection.

  The detached write completes in its own Harper immediate transaction before the
  lock is released, so the confirming re-read sees the row the same request wrote;
  a re-read that finds NONE is refused rather than answered from the local object.
  A contender that cannot take the lock within the deadline refuses (5xx) with the
  holder named — a documented fail-closed mode, not a retry; a dead worker thread
  in a live process blocks contenders until the deadline, so the remedy is to
  restart the process.

  `flair init --remote` does not take the lock yet — the CLI writer joining the
  same lock, and a store-enforced one-row invariant, remain desirable (slice 2).

  The two-thread `GET /FederationInstance` race test in `test/integration/` is a
  TRIPWIRE for the lock and the write seam: with no lock it ran red in 43 of 50
  rounds, with the lock 0 of 50. It is evidence about this code, not a promise
  that a future Harper commit-timing change would be caught by it.

  (Refs #1897)
