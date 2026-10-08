- **A Soul PATCH that overlaps another write no longer drops the other's field.**
  Each attempt re-reads the stored row, re-runs the PATCH guards against that
  read, writes the row built from it, and then re-reads the committed row before
  committing. A concurrent change aborts the staged write and the attempt
  retries from the committed row. A row replaced by a different subject (a
  different agent id or key, or gone) is refused with `soul_patch_row_changed`
  (409) and a row that keeps changing is refused with `soul_patch_conflict`
  (409), in both cases leaving the row and its version history unchanged.
