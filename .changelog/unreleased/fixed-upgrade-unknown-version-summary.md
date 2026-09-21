- **`flair upgrade` and `flair doctor` no longer misreport an install ahead of, or unparseable against, the published version.**

  `flair upgrade`'s no-upgrade summary printed `✅ Everything is up to date.` when
  an installed version could not be parsed — a convergence it cannot see — and
  the "N package not detected" line still claimed "all detected packages are up
  to date" with an `ahead`/`unknown` finding present. Both now say only what is
  true: the summary is neutral ("No upgrades available.") whenever any package is
  `ahead` OR `unknown`, an `unknown` package prints one line naming it and the
  raw string that could not be parsed, and the not-detected line reads "no
  upgrades available for the rest".

  `flair doctor` (and `doctor --fix`) classified ANY pin != the installed CLI as
  a stale failure, so a SessionStart-hook pin AHEAD of the running CLI rendered
  as `✗ … the hook still launches the OLD adapter`, was counted as an issue, and
  made `doctor --fix` exit 1 on a pin the never-lower guard deliberately
  preserves. Doctor now classifies pin direction before rendering: a pin AHEAD
  of the running CLI is a held pass (no `✗`, no issue count, no `--fix`); a pin
  BEHIND keeps today's stale error and re-pin.

  (Refs #1778)
