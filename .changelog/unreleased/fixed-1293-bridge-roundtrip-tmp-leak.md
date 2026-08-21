- The unit lane no longer leaks `flair-bridge-test-*` temp trees into TMPDIR
  on every run (#1293). `runRoundTrip` mkdtemps one tree per call and leaves
  it behind by design (its `tmpExportPath` is a debugging affordance); the
  round-trip unit suite now tracks each tree it causes and sweeps them in
  `afterAll`. Leaked trees have previously filled a builder host's disk and
  taken an agent offline. Test-lane hygiene only — no runtime behavior
  changes.
