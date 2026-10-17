- **The built-in /mcp `skill_store`, `memory_basement` and `memory_restore` replies report the stored, redacted text after a server-side redaction.** (#2558)

  Each reply now takes `content` (and `summary`/`trigger` when the write carried
  them) from the write's own response `stored`, reports the `redactedValues`
  count, and makes no read after the write, so a later write to the row cannot
  change what it reports. The caller's input is never echoed in place of a
  redacted field. A write the server did not redact returns its response
  unchanged; a write that reports the count without stored text omits those
  fields and sets `contentWithheld: true`.

  The `flair-mcp` stdio `skill_store` reply follows the same rule as its
  `memory_store`: after a redaction, its preview and `Trigger:` line come from
  the response's stored text (never the input), its structured result carries
  `redactedValues`, and a count with no stored text gives no preview, no
  trigger line and `contentWithheld: true`.
