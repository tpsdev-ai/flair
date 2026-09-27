- **adk-flair's `store_memory` tool no longer reports an unconfirmed memory write as stored.**

  `FlairMemoryService.add_memory` caught every exception from a direct memory
  write, logged a warning and returned normally, and the request helper treated
  any status below 400 (a redirect included) as success. So the `store_memory`
  tool could answer `{"status": "stored"}` when Flair had refused the record,
  was unreachable, or never confirmed it. Now only a 2xx confirms a request.
  `add_memory` attempts every text-bearing record and then raises
  `FlairWriteError` (a subclass of `FlairRequestError`) carrying `written`,
  `failed` (a list of `(record_id, status)`) and the first failure's
  `status_code`, with a message such as `3 of 4 memories written; 1 refused
  (status 403)`. After a timeout or connection error the record may or may not
  have landed. The `store_memory` tool returns `{"error": <message>,
  "written": n, "failed": m}` instead of `"stored"`.
  `add_session_to_memory` and `add_events_to_memory` still log and continue.

  (Refs #1938)
