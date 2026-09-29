- **In CI the unit lane now keeps going past a failing step and reports all failures at once, instead of stopping at the first.**
  `scripts/test-unit.ts` gained a keep-going mode: it attempts every later step until its time budget runs out,
  reports any step the budget leaves unrun, prints one final summary listing each failed step with its reason, and exits non-zero
  if any step failed. It is on by default when `CI` holds a truthy value
  (nonblank after trimming, excluding `0` and `false` case-insensitively;
  GitHub Actions sets `CI=true`), and
  available anywhere with `bun run test:unit --keep-going`. A local run without
  the flag keeps the fail-fast behaviour and stops at the first failing step,
  and `--fail-fast` forces that even when `CI` is set; the release script passes
  it. In keep-going mode each step is killed at its time limit (90 s; 360 s for
  the root unit tests step) and counts as a failed step, and the lane has a
  budget of 510 s, so the summary and guards are expected to print before the CI
  job's 10-minute limit as long as the job's work outside the lane stays within
  the 90 s reserved for it (measured, not guaranteed); a fail-fast run is not
  time-limited. The home-isolation and temp-leak guards run once at the end in
  either mode. In keep-going mode a guard failure is listed in the same summary,
  so it still fails the lane even when every step passed; in fail-fast mode each
  guard prints its own error and fails the lane, with no combined summary.

  (Closes #2030)
