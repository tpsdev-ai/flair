- **`flair init`: an ops-API agent-seed timeout now names the operation, target and timeout, and retries once.**

  Both ops-API seed paths — `flair init`'s agent seed and the `--remote` hub
  init's federation-instance seed — inserted through the Harper operations API
  with a single bare `fetch` under a 10 s client timeout. On a timeout the only
  output was an undici `DOMException [TimeoutError]` stack: no operation, no
  target, no timeout value. Each seed now retries the insert ONCE on the client
  timeout (safe because the insert is idempotent — a duplicate answers 409 and
  is treated as success), reports the first attempt's timeout and the second
  attempt's outcome with the sanitized target URL and the record id, and when
  both attempts time out fails with a concise error naming the operation, the
  table, the target and the 10 s budget. An auth failure (401) or any other
  HTTP or network error is never retried and keeps its existing message.

  (Refs #1790)
