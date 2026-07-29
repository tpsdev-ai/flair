- **A docs-freshness check that could not run no longer reports as passing
  (flair#953).** `cli-command-descriptions` introspects the CLI's command tree
  from the built `dist/cli.js`. On any machine where the CLI had not been built
  it printed "skipping", returned no failures, and the runner rendered it as
  `✓ pass` beneath a summary reading "All docs-freshness checks passed" — six
  ticks, one of which had verified nothing. The defect was never in a check; it
  was in what the runner does when a check cannot execute.

  The gate now carries three states — `✓ pass`, `⊘ DID NOT RUN`, `✗ fail` —
  through the per-check line, the summary tally and the exit code. A skip is
  never counted toward the pass total, so the tally cannot read `6/6` while
  something sat out, and the process exits `2` (distinct from `1` for real
  findings, so a wrapper can tell "your docs are stale" from "your environment
  is wrong"; both are non-zero, so CI treats them identically). Each skip names
  the unmet prerequisite and its remedy, and is emitted as a CI annotation
  rather than buried in the log.

  Two silent variants are closed at the same time. A check that examined **zero
  items** is now automatically a skip: passing checks report their corpus size
  (`✓ port-drift (26 prose docs scanned)`), so a glob or `existsSync` filter
  that empties after a rename shows up as `examined 0 prose docs` instead of
  being indistinguishable from a clean scan. And the gate refuses to report at
  all if a check fails to register, because a gate that runs zero checks
  announces success exactly as loudly as one that runs six.

  Nothing changes in CI, which builds the CLI and checks out full history before
  invoking the gate — that is the point: the gate was already passing there for
  real, and only ever went dark where nobody was looking. Running it locally
  without building the CLI first will now tell you so.
