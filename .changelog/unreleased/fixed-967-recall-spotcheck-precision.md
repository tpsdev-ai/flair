- **The nightly quality sweep's recall spot-check is report-only — it no longer
  emits `quality.regression` events (flair#967).** Measured over 32 nightly runs
  on a production instance, the metric's population σ was 0.291 and its mean
  absolute run-to-run delta 0.223, against a `QUALITY_EVENT_RECALL_DROP_THRESHOLD`
  of 0.2 — the alarm sat at 0.69σ, below the metric's own noise floor — and all 6
  findings-mails the sweep had ever produced in 34 runs were this metric
  oscillating. Lifetime precision: 0. The threshold literal is deliberately left
  at 0.2: alerting authority was removed from a metric that never earned it, not
  widened until it stopped talking. Recall regressions are detected by the
  deterministic, fixed-label, CI-gated eval
  (`test/integration-heavy/recall-eval-gate.test.ts`); `flair quality` still
  computes, prints and snapshots recall@k/MRR for observability.

  Two changes also make the retained number worth reading. `deriveRecallCue` no
  longer hands an opaque slug (`pr-1359`, `kern-2026-08-23`, or the sweep's own
  `quality-snapshot/<host>`) to semantic search as if it were a query — a
  same-instant A/B over the same ten memories scored recall@5 0.60 / MRR 0.16
  from subjects versus 1.00 / 0.78 from content — so a subject is used as the cue
  only when it is discriminative, and otherwise the leading words of the memory's
  content are. And a sampled window that cannot be scored fairly (two memories
  deriving the same cue, so they must displace each other in one result list, or
  a memory with no derivable cue at all) is now reported as UNHEALTHY with a
  self-describing reason instead of being scored anyway. The spot-check also
  stops grading its own `quality-snapshot` bookkeeping rows, which were a
  guaranteed miss and a permanent constant penalty on every instance running
  `flair quality --emit`.
