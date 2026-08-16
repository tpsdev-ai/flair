- **Golden-path smoke suite no longer flakes on a cold-start embedding
  timeout.** The embedding backend loads its model lazily on the first embed
  call, and `/Health` returning 200 does not mean that load has finished — so on
  a cold or loaded CI runner the first timed write (Step 2) could pay the model
  load and exceed `writeMemory`'s 10s client abort, surfacing as
  `TimeoutError: The operation timed out` at ~10s (flair#1219, seen across
  #1217/#1221/#1222). The suite now warms the embedding model in `beforeAll` via
  a throwaway agent+memory write with a generous budget, so the measured
  golden-path write is always a warm write. Test-only: production
  `writeMemory`'s 10s timeout is unchanged.
