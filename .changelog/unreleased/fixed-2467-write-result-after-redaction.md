- **Memory write results report the STORED text after a server-side redaction: the SDK's `write`/`update` result and the MCP `memory_store`/`memory_update` replies (#2467).**

  The server replaces credential-shaped text before storing a Memory and reports
  the count on the write response, without echoing the stored `content`.
  `MemoryApi.write()` and `MemoryApi.update()` now re-read the row so the
  result's `content` is the stored (redacted) text rather than the caller's
  input, and the MCP write replies preview that stored text and report the
  redacted-value count. A write the server did not redact is unchanged and makes
  no extra request.
