- **Memory refuses an id ending in `.content` at every client write path.**
  Harper reads a trailing `.content` on a by-id request as a property selector, so
  a by-id read naming such an id could be answered from the base id's record.
  POST/PUT/PATCH on Memory and the memory feed now refuse it with
  `memory_id_content_suffix`; the bridge importer refuses it before the write.

  > **Heads-up:** a non-admin read whose id segment carries an encoded `/` before a
  > property suffix is refused with `ambiguous_memory_id` rather than rewritten to
  > another record. Ids already stored that end in `.content` are not migrated.
