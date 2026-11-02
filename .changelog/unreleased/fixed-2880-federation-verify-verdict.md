- **`flair federation verify` reports a failed canary push as a failed verification.**

  A definitive canary write failure, an initial canary push that returns an
  error, and a `--peer` name that matches no listed peer use the
  `verification-failed` kind and a non-zero exit code. A peer that was verified
  missing the memory remains `diverged`. When a failed verification leaves an
  unknown-outcome cleanup request, its summary gives the count.
