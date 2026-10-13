- **The built-in `/mcp`, pi and OpenClaw write replies report the stored text after a server-side redaction, never the caller's input (#2537).**

  These replies now take the text from the write's own response, the `stored`
  fields that #2467 added next to `redactedValues`, and make no read after the
  write. The built-in `/mcp` `memory_store` and `memory_update` echo carries the
  count and the stored `content`, with `summary` and `trigger` when the write
  carried them; a skill `memory_update` with `preserveHistory` reports the
  successor row's id and text. The `pi-flair` `memory_store` reply previews the
  first 120 characters of the stored text, gives its size and states the count.
  The `openclaw-flair` `memory_store` reply adds a preview of the first 200
  characters of the stored text and states the count. When the response returns
  the count without the stored text, the `/mcp` echo omits the text fields, the
  pi and OpenClaw replies read `Preview: none.` and state the count, and all
  three set `contentWithheld: true`. A write the server did not redact gets the
  same reply as before.
