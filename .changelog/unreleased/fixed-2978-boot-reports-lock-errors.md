- **A migration-lock error is reported at boot instead of being skipped as single-flight.**
  Each refused acquisition is labeled `held` (another caller or process owns it, or
  won the race for it) or `error`. A `held` refusal stays quiet; an `error` refusal
  is reported, and the first boot cycle records the migrations as failed.
