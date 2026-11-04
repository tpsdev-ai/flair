- **A2A `message/stream` accepts requests that send `Accept: text/event-stream`.**

  Harper's REST layer dispatches a request with that header as CONNECT, not
  POST. The connect override forwards ANY POST whose body is a non-array object
  with string `jsonrpc` and `method` fields to post (including
  `"jsonrpc": "1.0"`); every other request keeps the default connect handling.
  post's answer is returned as post gives it: an SSE stream for an admitted
  `message/stream`, JSON-RPC objects for other methods and for refusals.
  `docs/api-reference.md` documents the header on `message/stream` (#2717).
