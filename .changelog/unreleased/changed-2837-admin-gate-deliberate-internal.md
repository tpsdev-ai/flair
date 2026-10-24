- **The admin-only gate refuses an `internal` verdict reached by omitting the context.**

  `allowAdmin` now admits the `internal` verdict only for a call that carries
  `internalContext()`'s marker and no request headers, so an embedder's call
  that reaches the gate with no context is refused there. The gate's decisions
  for HTTP credentials and agent contexts are unchanged. A resource's handler can
  apply its own rules after the gate, such as AgentSeed's Soul-write source
  rule and MemoryReindex's admin check.

  > **Heads-up:** pass `internalContext()` for a deliberate elevated in-process call.
