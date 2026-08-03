- **A hung old binary during a downgrade check is now reported as a hang, not as a clean refusal.**
  The downgrade invariant names three outcomes — the old binary boots, it refuses loudly, or
  anything else — and both enforcement points folded the third into the second. A timeout therefore
  printed a diagnosis stating the opposite of what had happened: an unbounded hang reported as a
  correct, loud refusal.

  Timeouts are now classified before the refusal check and fail with their own message. A pure
  `classifyDowngradeOutcome()` covers the three outcomes explicitly, so an invariant naming three
  states no longer has two branches.
