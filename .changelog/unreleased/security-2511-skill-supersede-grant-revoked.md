- **A grant-authorized, non-admin cross-agent supersede of a skill version re-checks its write grant before the close commits (#2511).**

  After the close is staged, the skill-version write re-reads the authorizing
  "write" grant on committed state — the shared write-back helper the non-skill
  close already uses — and, when a revocation is visible, refuses the write and
  rolls the whole transaction back: no predecessor close, no successor and no
  version row. Supersedes that carry no write grant — operator, internal and
  same-agent — are unchanged.
