- **Read-scope comments and model-facing tool text describe what the server does.**
  The shared client, the native memory tools and the Memory resource say that reads admit the caller's own records and other agents' non-private records; `memory_get`'s output text says the record is subject to the caller's read scope; the `flair_catchup` description says the configured agent id selects the feed, and the stdio `soul_set` description says soul writes need administrator credentials.

  (Refs #1943)
