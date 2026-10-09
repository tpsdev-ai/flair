- **`flair keys prune` and `flair doctor` report node-shaped orphan candidates without removing them.**
  Candidates are absent from the ops Instance and Agent tables after the sole ops
  Instance id matches the HTTP target's `HealthDetail.federation.instance.id`.
  An unavailable identity match or unreadable rows leave files unidentified.
  Node-shaped seeds stay in place even with `--apply`; removal requires per-file ownership proof (#2200).
  Minting attempts to record a sidecar; sidecar-write failure leaves them report-only.
  Doctor's advisory names no removal command (flair#1925).
