- **Concurrent relay sends, usage-feedback calls and IdP principal provisions serialize each write's deciding read with the write, committing it before the lock releases (#2333).**

  A relay `POST /Message`, a `POST /RecordUsage` and a jwt-bearer grant to
  `POST /OAuthToken` each read the store before they write it: a message id, a
  thread's last sequence number and a per-sender inbox count; an
  `(agent, memory)` usage-ledger row; an IdP subject's principal. Each write now
  runs while holding a per-key lock across its read and its write, and commits
  before that lock releases, so two requests that interleave on the same key
  cannot both act on state the other is about to change — one message id keeps
  one owner, a `(from, threadId)` sequence stays strictly increasing, the
  per-sender cap holds, one `(agent, memory)` pair contributes one usage count,
  and one IdP subject resolves to one principal — and a request that takes the
  just-freed lock re-reads the committed state rather than a write still in
  flight. A request that cannot take the lock is refused rather than applied:
  a relay send and a usage-feedback call write nothing, and a jwt-bearer grant
  writes nothing either — its assertion's one-time `jti` is claimed only after
  the subject lock is held, so a lock miss leaves the assertion usable and a
  retry of it can still succeed once.
