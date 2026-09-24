- **Auto-capture now normalises block-shaped messages, uses the client's UUID memory ids, and reports machine-readable store outcomes.**

  The capture paths (agent_end, llm_input, llm_output) read a host message's
  content through one function: text blocks are concatenated in order, and
  image, thinking and tool blocks contribute nothing (their contents never
  reach a memory). `memory_store` no longer hand-builds a `Date.now()` id — it
  uses the client's canonical UUID path, so two writes in one millisecond can
  no longer overwrite each other — and returns a machine-readable outcome
  (`written`, `id`, `supersedeClosed`, `errors`): `written` is true only after
  the primary write succeeded, a partial success (memory written,
  supersede-close failed) is reported as exactly that, and an unresolved
  identity returns `{ written: false, reason: "no-identity" }` instead of
  silently returning.

  (Refs #1751)
