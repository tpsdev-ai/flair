- **The dependency audit gate now reads each advisory's first allowlist appearance along every parent->child edge of the ancestry.** When a parent lacks the path, any file in its tree holding an id from the child's file is followed as a predecessor and must parse as an allowlist; otherwise the run fails by name. The first day is the earliest commit containing the id while none of its parents do, and a commit where the path appears with no id-bearing predecessor starts the lineage.

  The walk is bounded at 10,000 ancestor commits for CI.
