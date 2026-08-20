- **`--entities <csv>` on `flair memory add`, `flair workspace set`, and `flair orgevent`.**
  The `entities` fields documented in `docs/entity-vocabulary.md` are now reachable from the
  CLI: pass a comma-separated list of `type:value` vocabulary strings (e.g.
  `--entities "repo:tpsdev-ai/flair,issue:tpsdev-ai/flair#1288"`) and they land on the written
  record, feeding `flair attention`. Values are validated client-side against the closed type
  set before any signing or network work; a malformed value is rejected with an error that
  names the `type:value` format and lists the valid types. The `invalid_entity` rejections on
  `flair attention` and the server's `invalid_entities` write rejection now carry the same
  actionable hint (the server response gains an additive `message` field — `error` and
  `invalid` are unchanged). (#1288)
