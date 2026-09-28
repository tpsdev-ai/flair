- **ADK record ids for colon-bearing tuples sit outside historical event-join ids.**
  When an app, user, session, or event value contains `:`, both adk-flair
  packages percent-encode the components and join them with `|`. The result
  contains no `:`. The old event-join always contains at least three `:`, so
  a new id is not an event-join row the previous encoder stored. Tuples with
  no colon in any component keep the historical event-join id. A create
  conflict on an event write replaces the row only when it has a complete
  event stamp for that tuple. An unstamped pre-upgrade row is not replaced
  automatically; it is kept and the conflict is reported. A direct re-add of
  a caller-chosen id still replaces that row.
