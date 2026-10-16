- Skill POST, PUT without `_reindex`, and feed writes refuse metadata with
  duplicate top-level keys; otherwise `name`, `description` and string `tags`
  entries are redacted (#2575).

  After a counted redaction, successful Memory POST and PUT responses report
  in `stored` the skill fields the request supplied (`tags`, and the `name`
  and `description` of its `metadata`), each as stored, next to the supplied
  text fields (#2561); the feed reply holds the supplied `metadata` as stored,
  with `redactedValues`. After a counted redaction, the built-in /mcp `skill_store`
  reply echoes the stored skill fields; stdio renders the stored name, with no
  description or tags.
  On a clean write, stdio uses the input name. Clean field values are unchanged;
  a write with nothing to redact reports no count.
