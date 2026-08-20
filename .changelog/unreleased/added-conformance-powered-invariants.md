- **Conformance invariants powered (flair#1290).** The `/mcp` bootstrap
  contract's `countCoherence` now also runs under `includeTrust:true` (it had
  never executed on the trust path — the suite never enabled trust, and the
  trust tests never ran the contract). The tautological teammate entry
  (`teammateFindingsMatched` is *defined* as included + truncated, so the entry
  asserted X ≤ X) is dropped from the invariant array and the field documented
  as informational-derived. Two new invariant types: `hintWhenEmpty` asserts
  each empty-container hint (`predictedHint`/`eventsHint`/
  `teammateFindingsHint`/`currentTaskHint`) is present exactly when its real
  emission condition holds and absent otherwise, and `noOpEventsSuppressed`
  asserts zero-row no-op event suppression against `isZeroRowNoOpEvent`'s own
  classification instead of hardcoded fixture strings. A new large-store
  conformance test seeds the 251-record synthetic corpus-v2 across 8 agents in
  the live profile's ownership skew through the real embedding-generating
  write path and runs the full contract at a tight budget — the first CI run
  where bootstrap's admission/truncation accounting works at scale. The
  large-store suite runs in its own CI lane (`test/integration-heavy/`,
  "Integration Tests (heavy)") — its bulk CPU embedding cost (measured 253s on
  a CI runner) is isolated there instead of pressuring the main Integration
  lane's ceiling. Test- and contract-layer only; no runtime behavior changes.
