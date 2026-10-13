- **The built-in `/mcp`, pi and OpenClaw write replies report the STORED text after a server-side redaction (#2537).**

  The server replaces credential-shaped text before it stores a Memory and
  reports the count on the write response, without echoing the stored `content`.
  The built-in `/mcp` `memory_store`/`memory_update` replies and the `pi-flair`
  and `openclaw-flair` `memory_store` replies now report the stored content and
  the redacted-value count. A write the server did not redact is unchanged and
  makes no extra request.
