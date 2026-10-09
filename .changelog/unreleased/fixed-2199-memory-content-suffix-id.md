- **Memory POST/PUT/PATCH/DELETE refuse an id ending in `.content`.**
  Memory POST/PUT/PATCH/DELETE and FeedMemories POST refuse it with
  `memory_id_content_suffix`; the bridge importer refuses it before the write.

  > **Heads-up:** a non-admin Memory GET with `%2F`/`%2f` in its last path segment
  > and a declared property name after its first decoded dot returns
  > `400 ambiguous_memory_id`; HEAD returns an empty 400. Ids already stored that end in `.content` are not migrated.
