- **The `Memory` skill-version create/update writes take the per-memory write lock (flair#2950).**

  A skill `PUT`/`POST` create or update that names an id or addresses a stored
  row locks the row it addresses and the live head it would close, in the same
  sorted per-id set as a skill-tagged `POST /FeedMemories` write. The writer
  resolves the live head under the locks and re-acquires with it when it is
  outside the held set. Its pre-confirmation work runs after the Memory lock
  releases, so a later same-subject write can still complete and be confirmed in
  order.
