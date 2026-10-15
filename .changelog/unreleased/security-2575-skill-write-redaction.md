- **Server-side write redaction now covers a skill's `name`, `description` and every `tags` entry, through the same redactor the Memory text fields already use (#2575).**

  A skill-tagged Memory write whose `metadata` `name`/`description` or `tags`
  entries carry credential-shaped text is stored with those values replaced,
  the same way a Memory `content`/`summary`/`trigger` write is. The write
  response's `stored` reports the redacted skill fields next to the Memory text
  fields. After a counted redaction, the built-in /mcp `skill_store` reply
  echoes the stored skill fields; stdio renders the stored name, with no
  description or tags. On a clean write, stdio uses the input name. Redaction
  leaves clean field values unchanged; a write with nothing to redact reports
  no count.
