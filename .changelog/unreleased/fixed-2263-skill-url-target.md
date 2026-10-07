- **Skill creates at `/Memory/<id>` use that id when the body id is absent or null; the feed refuses reserved seed ids.**

  Updates retain the lineage and follow the existing successor or reserved-id
  rules. The locked stale check compares the addressed row. PUT refuses a body
  `id` that differs from the URL id.

  After authentication, the feed's reserved-id check refuses a URL id, body id, or `supersedes`
  naming the seed id, with a 403 naming `flair init` as its writer; the seed
  writes that row through `PUT /Memory/<id>`.
