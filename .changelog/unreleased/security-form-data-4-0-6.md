- **`form-data` pinned forward to `^4.0.6`, clearing GHSA-fjxv-7rqg-78g4 (critical
  — predictable multipart boundary from an unsafe random function) and
  GHSA-hmw2-7cc7-3qxx (high) — and retiring both audit-gate allowlist entries in
  the same PR, exactly as their `removeWhen` conditions required.** The vulnerable
  `form-data@4.0.0` was pinned exactly by `n8n-workflow@1.119.0` under the
  first-party `@tpsdev-ai/n8n-nodes-flair` workspace package, so the lever is a
  root `overrides` entry — bun overrides are flat and cannot be scoped to one
  dependency edge, the same mechanism (and the same caveat) recorded for every
  prior pin in that block. The flat override also moves `@types/request`'s
  `form-data` (previously a separate `2.5.6` resolution, itself outside the
  vulnerable range) onto `4.0.6`, collapsing the duplicate out of `bun.lock`; that
  edge is a types-only consumer with no runtime path. Both allowlist entries
  carried `expires: 2026-08-26` — the gate would have started hard-failing the
  build within days, which is the mechanism working as designed. As with the
  earlier batch: an override is a forward pin, not a fix — it comes off when
  n8n-workflow resolves a patched `form-data` on its own.
