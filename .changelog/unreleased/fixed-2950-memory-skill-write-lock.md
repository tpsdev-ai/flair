- **The `Memory` skill-version create/update writes take the per-memory write lock (flair#2950).**

  A skill `PUT`/`POST` create or update that names an id or addresses a stored
  row locks the row it addresses and the live head it would close, through the
  same sorted per-id lock helper as a skill-tagged `POST /FeedMemories` write.
  The skill writer returns an existing addressed or live-head id it must lock,
  and the verb (`put()`/`post()`) re-acquires the extended set; the writer
  resolves the live head under the locks. A fresh skill `POST` with a
  server-allocated id takes no per-id lock. Its pre-confirmation work runs after
  the Memory lock releases.
