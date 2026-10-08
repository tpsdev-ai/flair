- **A by-id Memory POST ending in `.content` is refused.** `Memory.post` now
  passes its request target to the `.content`-suffix id guard, as `Memory.put`
  and `Memory.patch` do. Requests reaching that guard return
  `400 memory_id_content_suffix` before any row is written; earlier guards keep
  their own refusal responses.
