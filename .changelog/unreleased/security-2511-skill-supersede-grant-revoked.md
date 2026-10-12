- **A grant-authorized cross-agent close of a skill version re-checks its write grant before the close commits (#2511).**

  This covers a skill supersede through `/Memory` or `POST /FeedMemories`, and a
  `DELETE` of a stale skill id whose live head is another agent's row. After the
  close is staged, the skill-version write re-reads the authorizing "write" grant
  on committed state — the check the non-skill close already runs — and, when a
  revocation is visible, refuses the write with 409 `granted_close_revoked` and
  rolls the whole transaction back: no close, no successor and no version row. A
  revocation committed after the re-check is not seen. Closes that carry no
  write grant — operator, internal and same-agent — are unchanged.
