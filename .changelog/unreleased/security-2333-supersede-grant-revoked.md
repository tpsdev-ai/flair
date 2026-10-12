- **A grant-authorized, non-admin cross-agent supersede of a non-skill memory re-checks its write grant before the close commits (#2333).**

  The close re-checks the grant on committed state inside its transaction, after
  it stages its write, and stops without closing when the revocation is visible at
  that re-check. A revocation committed after the re-check is not seen.
  Skill-version supersedes are unchanged.
