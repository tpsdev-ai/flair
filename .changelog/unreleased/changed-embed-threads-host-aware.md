- **Embedder thread count is now host-aware, and overridable via
  `FLAIR_EMBED_THREADS`** (flair#1330). Flair now passes `threads` through
  `embeddings-boot` to harper-fabric-embeddings instead of inheriting HFE's
  fixed default of 6 — which left cores idle on an 8-vCPU ingest host and
  oversubscribed a 4-core one. Unset, the value is
  `max(1, availableParallelism() − 1)` (cgroup-aware; one core left for
  Harper). Set `FLAIR_EMBED_THREADS` to a positive integer to pin. Invalid
  values fall back to the default. Env-only — not a `config.yaml` key.
