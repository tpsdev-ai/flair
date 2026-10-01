- **The promote block's final check waits up to 120 s for the registry to show the new `latest` before it reports skew.**
  In 0.58.0 the check read each package's `latest` once with `npm view`, straight
  after the last `npm dist-tag add`. The registry can serve the previous `latest`
  for a short time after a move, so after the 0.57.0 and 0.58.0 promotes the check
  reported skew for `@tpsdev-ai/flair` and printed RESTORE lines for a promote that
  had succeeded. The block now runs the check in a wait mode
  (`scripts/ci/registry-latest-skew.mjs <version> --await 120`, with each package's
  previous `latest`). It reads every `latest` from the registry's dist-tags
  endpoint (`npm dist-tag ls --prefer-online`) and re-reads a package that is not
  yet at the new version, with backoff, until it is or the wait ends. If every such
  package still reads its previous `latest` then, the check exits 3 and the block
  prints the command to re-run the check, then the RESTORE lines as a fallback.
  Skew and an unreadable `latest` still exit 1 and 2, and the block prints the
  RESTORE lines for them as before. Without `--await` the check reads and reports
  as in 0.58.0, including the canary's pre-promote report; an extra argument it
  used to ignore is now a usage error (exit 2).

  (Closes #2140)
