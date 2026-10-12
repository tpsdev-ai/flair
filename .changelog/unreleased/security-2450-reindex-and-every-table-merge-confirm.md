- **Administrator reindex writes and federation merges refuse detected changes to their stored targets.**
  A missing or changed Memory identity returns 409 `stored_row_changed` for
  `_reindex`. Planned federation Memory writes skip changed target identities;
  planned Soul, Agent, Relationship, and Message writes skip changed stored rows
  as `merge_target_changed`.
