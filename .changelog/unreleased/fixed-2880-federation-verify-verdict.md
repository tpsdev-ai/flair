- **`flair federation verify` reports a failed verification as a failed check.**

  A canary write that fails, a sync step that returns an error, and a `--peer`
  name that matches no listed peer use the `verification-failed` kind and a
  non-zero exit code. A peer that was verified missing the memory remains
  `diverged`. When cleanup leaves an unknown outcome, the summary gives the
  count of those requests. A genuinely empty peer set still reports "no peers
  to probe."
