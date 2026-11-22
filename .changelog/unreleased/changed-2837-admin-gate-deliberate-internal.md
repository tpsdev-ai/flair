- **`allowAdmin` admits the `internal` verdict only when the context carries `internalContext()`'s marker and no request headers.**

  A call that reaches the gate with no context is refused there. The gate's
  decision for an `agent` or `anonymous` verdict is unchanged. A resource's
  handler can apply its own rules after the gate.

  > **Heads-up:** pass `internalContext()` for a deliberate elevated in-process call.
