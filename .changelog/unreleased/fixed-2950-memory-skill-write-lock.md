- **The `Memory` skill-version create/update writes take the per-memory write lock (flair#2950).**

  A skill `PUT`/`POST` create or update that names an id or addresses a stored
  row locks the row it addresses and the live head it would close, through the
  same sorted per-id lock helper as a skill-tagged `POST /FeedMemories` write.
  The skill writer returns an existing addressed or live-head id it must lock,
  and the verb (`put()`/`post()`) re-acquires the extended set; the writer
  resolves the live head under the locks. A fresh skill `POST` with a
  server-allocated id takes no per-id lock. Its pre-confirmation work runs after
  the Memory lock releases.

  > **Heads-up:** two responses callers may now see. A `PUT`, or a `POST` that
  > names an id, whose body cannot be structured-cloned is refused with
  > `400 memory_body_uncloneable` (any memory write, not only skills). A Memory
  > skill create or update returns `409 skill_head_moved` when the live head keeps
  > moving across its lock attempts, as skill-tagged `POST /FeedMemories` already does.
