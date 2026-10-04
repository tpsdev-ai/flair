- **A skill write whose body omits `id` now targets the URL-bound id; the feed ingest refuses reserved seed ids.**

  Skill creates use the URL id when the body omits it. Updates retain the
  lineage and follow the existing successor or reserved-id rules. The locked
  stale check compares the addressed row. PUT refuses a body `id` that differs
  from the URL id.

  After authentication, the feed's reserved-id check refuses `id` or `supersedes`
  naming the seed id, with a 403 naming `flair init` as its writer; the seed
  writes that row through `PUT /Memory/<id>`.
