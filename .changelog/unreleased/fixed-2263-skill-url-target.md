- **A skill write whose body omits `id` now targets the URL-bound id; the feed ingest refuses reserved seed ids.**

  With a URL-bound skill body that omits `id`, the write lands at the URL id
  — an identical retry supersedes that same skill instead of creating a second
  one — and the under-lock stale check compares the row at that id. A body
  `id` that differs from the address is refused, as before.

  `/FeedMemories` refuses a reserved seed id, named as `id` or as `supersedes`,
  with a 4xx naming `flair init` as that row's writer; the seed writes that row
  through `PUT /Memory/<id>`.
