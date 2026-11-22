- **`flair rem nightly run-once` prints a failed pending-candidate count as
  `Pending: unknown (<reason>)` instead of `Pending: 0`.** The failure is listed
  under `Errors:`, so the run's status is `failed` and the command exits 1. A
  successful query still prints its exact count, and a run with no admin credential
  prints the count as unknown when it reaches the candidate-count step. In `rem-nightly.jsonl` an unknown
  count is `{ "state": "unknown", "reason": "..." }`, and the snapshot's
  `metadata.json` records `pendingCandidateCount: null`. `flair rem restore`
  now reports an unrecognised operations-API response body as an error
  instead of as no leftover candidates (#2680).
