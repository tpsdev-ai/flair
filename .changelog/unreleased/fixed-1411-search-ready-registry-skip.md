- **`/Health` now warns once when search route-mount verification is skipped** (flair#1411).
  If Harper's `server.resources` registry is absent, `searchReady` still
  fail-opens on the table check alone — that decision is unchanged — and
  names the degradation in a once-only warn instead of staying silent. The
  public `{ok, searchReady}` shape is unchanged.
