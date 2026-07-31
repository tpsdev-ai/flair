- **Every memory write now reports the visibility it landed on.** The write
  response was `{ id, written, deduplicated }`, so the one field on a memory
  most likely to have been decided by a rule the writer never typed was also the
  one field the writer could not observe without a second read. It now carries
  `visibility` as well, on every surface at once: the JSON `flair memory add`
  prints, the REST write response, and the `memory_store` result on both MCP
  surfaces — including the stdio adapter's "effective visibility" line, which
  read this field all along and had nothing to read, so it always rendered
  "(server default)".

  Additive: `id`, `written`, `deduplicated` and the dedup collision fields are
  unchanged. The key is omitted, rather than reported as `null`, for a patch of
  a record written before the field existed — absent visibility reads as
  non-private, so reporting `null` there would suggest the opposite.
