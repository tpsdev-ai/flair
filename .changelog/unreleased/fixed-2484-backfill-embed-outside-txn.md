- **The embedding backfill computes its vector before its write transaction opens.** (#2507)

  Rows without content or with an embedding longer than 100 entries are skipped
  before content comparison. For eligible rows, content is compared before
  staging and the committed row is confirmed afterward. Drift observed by
  either check aborts the attempt; remaining outer attempts re-read and may
  recompute. Changes after confirmation and before commit are not detected by
  these checks.
