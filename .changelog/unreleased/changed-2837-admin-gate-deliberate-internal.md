- **The admin-only gate refuses an `internal` verdict reached by omitting the context.**

  An embedder that calls an admin-gated resource with no context now gets a
  refusal. Administrator credentials, admin agents and a deliberate
  `internalContext()` call are still admitted.

  > **Heads-up:** pass `internalContext()` for a deliberate elevated in-process call.
