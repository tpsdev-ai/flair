- **OpenClaw callback warnings suppress repeated keys while those keys remain in a bounded cache.**

  Missing-identity warnings from `agent_end`, `llm_input` and `llm_output`
  are keyed by callback source. Capture and bootstrap-recall refusals or
  failures use the agent identity (or `no-identity`), callback site and error
  class. The class includes the error name and numeric status when present;
  otherwise it uses the error name and a truncated message.

  The shared warning cache retains up to 10,000 keys and evicts the oldest
  inserted keys when full. Repeats are suppressed while their key remains
  cached; an evicted key can produce another warning. Missing host identity
  or an unusable signing key is refused before any outgoing request.

  (Refs #1751, #1884)
