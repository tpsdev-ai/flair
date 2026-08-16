- **`bootstrap` now explains WHY any empty structured container is empty.** An
  empty `events: []` was byte-indistinguishable from the 0.44.8 regression where
  events were silently dropped — a connector could only tell the difference by
  diffing against a previous payload (flair#1182). The self-describing rule that
  already covered `predicted` is now applied across the containers: when a
  container ships empty the payload carries a short hint naming the reason and
  what fills it — `eventsHint`, `teammateFindingsHint` (alongside the existing
  `predictedHint`) — present only when that container is empty, so a healthy
  payload is unchanged. With `includeTrust: true`, a trust entry whose
  `matchQuality` is `null` now carries a `matchQualityNote` saying why: on the
  lifecycle sections (`permanent`/`recent`/`predicted`) a null band is correct —
  those are a window load, not a retrieval surface — not a scoring failure on
  your own records (flair#1225, documented in `docs/mcp-clients.md`).
