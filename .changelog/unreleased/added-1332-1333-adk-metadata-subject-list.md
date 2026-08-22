- **adk-flair: `custom_metadata` is now stored and returned, `subject` becomes
  a first-class column, and `list_memories()` lands** (flair#1332, flair#1333;
  design flair#1202). `add_memory()`/`add_events_to_memory()` serialize
  `custom_metadata` into a new client-writable `Memory.metadata` JSON field —
  store-and-return only, exactly ADK's contract: the blob is opaque to the
  server and no key in it has any server-side effect (contract-tested:
  `{"visibility":"shared"}` in the blob leaves the record private). Caps
  reject with `ValueError`, never truncate: 64KB serialized, nesting ≤ 16,
  ≤ 512 keys; non-serializable values skip that key with a WARNING.
  `subject` (≤ 512 chars, explicit param authoritative over
  `custom_metadata["subject"]`, never auto-extracted) is promoted to the
  record's existing indexed `subject` column. `search_memory()` returns both
  on `MemoryEntry.custom_metadata` (top-level subject surfaced as
  `custom_metadata["subject"]`; malformed blobs fail soft to `{}` with a
  WARNING) via a new opt-in `includeMetadata` flag on `/SemanticSearch` —
  the default projection (and every other consumer's response) is
  byte-unchanged. `MemoryEntry.author` now carries the writing agent id
  (was always `None` — read a field Flair never projected). New
  `list_memories(app_name, user_id, limit≤200, offset)` — a Flair-specific
  extension beyond `BaseMemoryService` — pages memories newest-first with
  the full projection, scoped by compound tag + agent identity, both pushed
  down and re-verified client-side.
