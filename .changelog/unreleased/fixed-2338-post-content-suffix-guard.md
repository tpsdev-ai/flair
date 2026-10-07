- **A by-id Memory POST ending in `.content` is refused.** `Memory.post` now
  passes its request target to the `.content`-suffix id guard, as `Memory.put`
  and `Memory.patch` do, so such a write returns `400 memory_id_content_suffix`.
