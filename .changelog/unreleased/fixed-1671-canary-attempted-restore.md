- **The canary promote block restores a package whose `dist-tag add` FAILED, and says
  so when the final check cannot read the state.**

  A failed `npm dist-tag add` can still have applied the tag server-side (npm may
  exit non-zero after the write), so that package is now reported as ATTEMPTED with
  its state UNKNOWN and gets a restore line like every moved package; only packages
  never attempted are listed as not moved. When the convergence check exits because
  it could not READ the current state, the block no longer says every package moved —
  it says the state is unknown and prints the restore lines. The emitted text also
  stops claiming a stale PASS is refused: the preflight is an EQUALITY check of the
  certified package-set digest, not a freshness check.

  (Refs #1671)
