- **The `Memory` skill-version create/update writes take the per-memory write lock (flair#2950).**

  A skill `PUT`/`POST` create or update takes the same sorted per-id lock set as
  a skill-tagged `POST /FeedMemories` write: the successor id, the addressed id,
  the predecessor and the live head it would close. The live head is resolved
  before the acquisition and resolved again under the locks; a head outside the
  held set releases and retries with the new head.
