- Skill POST, PUT without `_reindex`, and feed writes refuse metadata with
  duplicate top-level keys; otherwise `name`, `description` and string `tags`
  entries are redacted (#2575).

  The write response's `stored` reports the redacted skill fields. After a
  counted redaction, the built-in /mcp `skill_store` reply echoes the stored
  skill fields; stdio renders the stored name, with no description or tags.
  On a clean write, stdio uses the input name. Clean field values are unchanged;
  a write with nothing to redact reports no count.
