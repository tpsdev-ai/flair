- **A2A `message/stream` accepts requests that send `Accept: text/event-stream`.**

  Harper's REST layer dispatches a request with that header as CONNECT, not
  POST, so the adapter's connect path hands a POST body that is a JSON-RPC
  request to the same post dispatch. Authentication, the caller-match rule for
  `message/send` and `message/stream`, and the invalid-params refusal are the
  same with the header; a request with the header that is not a JSON-RPC POST
  keeps the resource's default connect handling. `docs/api-reference.md`
  documents the header on `message/stream` (#2717).
