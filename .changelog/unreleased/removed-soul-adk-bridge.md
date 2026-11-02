- **The Soul `adk:` compatibility bridge is removed; refusals now come from the generic checks.**

  Soul content refusals now come from the vendor-neutral checks: a write that
  would store a non-empty `scopeTag` or a non-empty `tags` array is refused with
  `soul_scope_fields_not_writable`, and a value that matches stored Memory or
  MemoryCandidate text for the target agent is refused with
  `soul_value_is_learned_content`.
