- **`flair agent stamp-home` and `flair principal add` guard a stored Agent home on their write paths (#2472, #2473, #2474).**

  `flair agent stamp-home --apply` checks the current instance identity and
  Agent eligibility during the write, and counts only confirmed stamps.

  `flair principal add` assigns a resolved home on insert; its updates preserve
  the stored home and federation bookkeeping fields.

  Both commands now apply the same local port-pair check before writing.
