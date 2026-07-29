- **Record ownership is enforced on every write verb, for every table.** Only a
  record's owner (or an administrator) may modify it. That rule was written into
  each resource's `put()` handler — but Flair's HTTP layer maps verbs to
  resource methods one-to-one, so a rule living in `put()` was enforced on `PUT`
  and nothing else, and no resource implemented the partial-update verb. Any
  verified agent could therefore modify records belonging to another agent,
  across most of the API surface, including credentials and memory grants.

  Where a check did run, it compared the owner named in the *request body* — the
  value the caller supplied — rather than the owner stored on the record being
  written, so a request that simply omitted that field was checked against
  nothing.

  Both are now enforced in one shared guard that runs on every mutating verb and
  reads ownership from stored state. Creating records, writing your own records,
  and administrator access are all unchanged. A test enumerates the schema and
  fails the build if a table with an owner column is ever added without being
  covered, so this cannot silently regress.
