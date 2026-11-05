- **The dependency audit gate reads each advisory's first allowlist appearance from every ancestor commit, not git's rename heuristic.** A low-similarity rename no longer shifts an entry's history day, and a shallow clone or an unlinkable rename fails the run by name.

  The walk is bounded at 10,000 ancestor commits for CI.
