- **Server-side write redaction now covers a skill's `name`, `description` and every `tags` entry, through the same redactor the Memory text fields already use (#2575).**

  A skill-tagged Memory write whose `metadata` `name`/`description` or `tags`
  entries carry credential-shaped text is stored with those values replaced,
  the same way a Memory `content`/`summary`/`trigger` write is. The write
  response's `stored` reports the redacted skill fields next to the Memory text
  fields, and the built-in /mcp and stdio `skill_store` replies echo the stored
  value, never the caller's input. A skill write with nothing to redact is
  stored unchanged and reports no count.
