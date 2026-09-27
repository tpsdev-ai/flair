- **adk-flair's Python write path no longer reports a failed memory write as stored.**

  `AdkFlairMemoryService.add_memory` caught every exception from a direct memory
  write, logged a warning, and returned normally, so the `store_memory` tool
  answered `{"status": "stored"}` even when Flair refused the record or was
  unreachable and the memory was gone. A failed write now raises
  `FlairWriteError` — a subclass of the `FlairRequestError` the README already
  promised for this path — carrying `written`, `failed` (a list of
  `(record_id, status)`) and the first failure's `status_code`, with a message
  such as `3 of 4 memories written; 1 refused (status 403)`. The `store_memory`
  tool catches it and returns `{"error": <message>, "written": n, "failed": m}`
  in place of `"stored"`, so the model knows what landed and what did not.

  (Refs #1938)
