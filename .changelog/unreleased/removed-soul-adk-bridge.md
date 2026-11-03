- **The Soul `adk:` compatibility bridge is removed; refusals now come from the generic checks.**

  Authorized Soul resource POST/PUT with a non-empty `scopeTag` or non-empty
  `tags` array in the request body, and authorized PATCH with those fields in
  the merged row after its stored-row checks, receive
  `soul_scope_fields_not_writable`.
  A learned-text refusal reports `soul_value_is_learned_content` for a
  non-empty exact value match with stored Memory or MemoryCandidate text for
  the target agent.
