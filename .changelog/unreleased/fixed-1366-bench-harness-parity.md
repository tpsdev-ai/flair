- **The LongMemEval bench harness in the repo is now the harness that produced
  the numbers.** The adaptations made on the bench VM during the headline runs —
  ollama-cloud key-file auth with 429/5xx backoff, shared-store ingest-reuse,
  resume from the per-eval journal, and the hardened readiness gate — lived only
  on that VM, so "run it yourself" reproduced a *different* harness than the one
  that made the numbers. They are ported here, with each knob classified as
  artifact-affecting (enters the hashed config) or operational-only, and a
  standing test that reconstructs each published run's manifest from repo code
  and asserts it content-addresses to that run's recorded `configHash`. The
  reconstruction is projected onto the key set the artifact actually recorded,
  so the manifest can keep growing without invalidating past artifacts — while a
  changed pin, prompt or extraction method still fails loudly.

  The cloud model pins are added as a `LME_MODEL_PROFILE=local|cloud` selector
  rather than by editing the pinned constants, so `local` stays the default and
  hashes exactly as before — no already-published local artifact is invalidated.

  Bench tooling only; nothing in the shipped package changes.
