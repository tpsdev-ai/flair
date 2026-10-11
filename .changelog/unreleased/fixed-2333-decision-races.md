- **Concurrent relay sends, usage-feedback calls and IdP principal provisions serialize each decision's read with the write it decides, committing before the per-key lock releases (#2333).**

  A relay `POST /Message`, a `POST /RecordUsage` and a jwt-bearer grant to
  `POST /OAuthToken` each read the store before they write it: a message id, a
  thread's last sequence number and a per-sender inbox count; an
  `(agent, memory)` usage-ledger row; an IdP subject's principal. Each decision
  write now runs while holding a per-key lock — within one Harper process —
  across its read and its write, and commits before that lock releases, so two
  requests that interleave on the same key cannot both act on state the other is
  about to change — one message id keeps one owner, a `(from, threadId)` sequence
  stays strictly increasing, the per-sender cap holds, one `(agent, memory)` pair
  contributes at most one usage count, and one IdP subject resolves to one
  principal — and a request that takes the just-freed lock re-reads the committed
  state rather than a write still in flight. A request that cannot take the lock
  does not apply its decision: a relay send writes no message, a usage-feedback
  call skips that contribution and still answers `{recorded:true}`, and a
  jwt-bearer grant is refused without writing — its assertion's one-time `jti` is
  claimed only after the subject lock is held, so a lock miss leaves the assertion
  usable and a retry of it can still succeed once.
