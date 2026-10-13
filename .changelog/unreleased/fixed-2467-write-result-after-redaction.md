- **After a server-side redaction, Memory write results report the stored text fields, never the caller's input for a field the server changed (#2467).**

  When the server replaces credential-shaped text in a Memory POST, PUT or
  PATCH, the response now carries `stored` next to `redactedValues`: the
  post-redaction values of the `content`, `summary` and `trigger` fields
  present in that write, as it committed them. A field the redaction did not
  change keeps the caller's value, so a summary-only redaction reports
  `content` as written; a PATCH reports only the fields in its body; a skill
  update that versions to a successor row reports that row's id. A write with
  nothing to redact gets no `stored`. `MemoryApi.write()` and
  `MemoryApi.update()` take those fields from `stored` and make no read after
  the write, so a later write to the row cannot change what the result
  reports. Against a server that reports the count without `stored`, the
  result has no `content`, `summary` or `trigger` and is marked
  `contentWithheld: true`. The MCP `memory_store` and `memory_update` replies
  preview the first 120 characters of the selected text, followed by `...`
  when truncated. With a count, that text is the stored `content` and the
  reply reports the count; with the stored text withheld there is no preview,
  and the reply states the count and that the stored text was not returned,
  without naming a field. With no count, the text is the result's `content`,
  else the input.
