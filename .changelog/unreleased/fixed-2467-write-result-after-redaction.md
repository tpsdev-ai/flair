- **Memory write results report the stored text after a server-side redaction, never the caller's input (#2467).**

  When the server replaces credential-shaped text in a Memory POST, PUT or
  PATCH, the response now carries `stored` next to `redactedValues`: the
  redacted `content`, `summary` and `trigger` that write committed (a PATCH
  reports only the fields in its body; a skill update that versions to a
  successor row reports that row's id). A write with nothing to redact answers
  as before. `MemoryApi.write()` and `MemoryApi.update()` build a redacted
  result from that response and make no read after the write, so a later
  write to the row cannot change what the result reports. Against a server
  that reports the count without `stored`, the result has no `content`,
  `summary` or `trigger` and is marked `contentWithheld: true`. The MCP
  `memory_store` and `memory_update` replies preview only the stored text and
  report the count; with the content withheld they say so and show no
  preview.
