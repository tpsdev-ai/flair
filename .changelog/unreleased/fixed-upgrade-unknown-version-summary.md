- **`flair upgrade` no longer prints "Everything is up to date" when an installed
  version could not be parsed.**

  An installed version that fails to parse renders as `❔ unknown`, but when
  nothing was outdated or missing the summary still claimed
  `✅ Everything is up to date.` — a convergence the command cannot actually
  see. The summary is now neutral ("No upgrades available.") whenever any
  package is `ahead` OR `unknown`, and an `unknown` package additionally
  prints one line naming it and the raw string that could not be parsed.

  (Refs #1778)
