- **Concurrent first-boot `GET /FederationInstance` requests create exactly one identity row, and every caller is answered with it.**

  The read-mint-write runs under a Flair-owned filesystem bakery lock in the
  STORE's root (`<rootPath>/flair-locks/instance-create/`, NOT `$HOME/.flair`), so it serialises **every HTTP worker of
  one Harper process** — not just one — and separate processes that share the same
  Flair home. The holder rule is Lamport's bakery on files: a contender writes a
  complete claim (tmp then atomic rename), takes the next ticket
  (`1 + max visible ticket`), and holds once its ticket is the smallest live one.
  No timing assumption — only atomic create, atomic rename within one directory,
  and live-pid detection. The lock lives with the STORE it protects, so an
  UNUSABLE keystore (a FILE `$HOME/.flair`) no longer blocks identity creation —
  flair#1233's contract: the row is still created and reads answer 200 with
  `signingKeyAvailable:false` (test: `test/integration/federation-status-keystore-1233.test.ts`).

  The detached write completes in its own Harper immediate transaction before the
  lock is released, so the confirming re-read sees the row the same request wrote;
  a re-read that finds NONE is refused rather than answered from the local object.
  A contender that cannot take the lock within the deadline refuses (5xx) naming
  the blocking claim when known — the live holder, or a contender still choosing;
  the deadline covers the choosing state too, and every exit (a hold, a refusal, or
  a throw from a hook) releases whatever claim this contender created. This is a
  documented fail-closed mode, not a retry. Residual: a claim whose pid is reused,
  or a dead worker thread inside a live process, blocks contenders until the
  deadline — refusals until the process restarts (a recognised claim whose body is
  missing, invalid, or disagrees with the pid in its filename is such a blocker,
  never reclaimed by another contender).

  `flair init --remote` does not take the lock yet — the CLI writer joining the
  same lock, and a store-enforced one-row invariant, remain desirable (slice 2).

  The two-thread `GET /FederationInstance` race test in `test/integration/` is a
  TRIPWIRE for the lock and the write seam: with no lock it ran red in 43 of 50
  rounds, with the lock 0 of 50. It is evidence about this code, not a promise
  that a future Harper commit-timing change would be caught by it.

  (Refs #1897)
