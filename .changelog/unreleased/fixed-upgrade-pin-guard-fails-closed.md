- **The pin refresh fails closed on a pin it cannot compare, and `flair doctor` reports an unparseable pin instead of calling it stale.**

  A hook or client pin that was not strict semver (a dev/nightly pin, or a
  hand-edited value) passed the never-lower guard and was OVERWRITTEN with the
  running CLI's version, and `flair doctor` rendered it as a stale "OLD adapter"
  error routed to `--fix`. The guard's decision now fails closed: any write it
  cannot PROVE is not a lowering is held, so an unreadable pin is never
  rewritten. `pinDirection` stays three-valued, and `unknown` is its own
  finding — a non-blocking warning (in the install-health catalog and in
  doctor's output) that names the raw value, is never auto-re-pinned, and is
  never worded as an old adapter. `behind` and `ahead` are unchanged.

  (Refs #1778)
