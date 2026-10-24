- **The CLI's shared REST helper now reports a failed request with a bounded one-line reason instead of the whole response body.**
  Apart from a refused redirect and a credential-less 403, which keep their own
  messages, the message reads `HTTP <status>`, then the JSON body's `error`,
  `code` or `message` string, or else an excerpt of the body. Either is one
  line: line breaks become spaces, other control characters are removed, and
  text past 200 characters is cut to at most 200 characters, after which
  `...` is appended. When the
  helper builds that message from a response body it read and `FLAIR_DEBUG` is
  set, it also writes that body's display form to stderr, encoded as one JSON
  string (#2764).

  In the message and that stderr line, the credential values the CLI reads from
  the request's Authorization header (the header value, the part after its
  scheme, a Basic header's decoded `user:password` and password, a TPS-Ed25519
  signature) are replaced with `[redacted]` in the text the server supplied. A
  Basic header in the form Flair's server accepts, and a TPS-Ed25519 header,
  are read with the server's own grammar. When the header names the Basic,
  Bearer or TPS-Ed25519 scheme but no credential can be read from it, the
  server's non-empty text is shown as `[body withheld]` instead (an empty body
  stays empty and the message is the status alone). The stderr line shows a
  JSON body re-serialized, or withheld when it cannot be, and the request path
  percent-decoded (withheld when it does not decode or holds a control
  character). Redaction removes the request's credential values from the text
  the server supplied (literal, inside any JSON string, percent-encoded); text
  the CLI writes itself (the `HTTP <status>: ` prefix, the debug line's labels,
  a caller's `Error: ` prefix) is never altered, so a credential that matches
  the CLI's own wording, or matches only once that wording is joined to the
  server's text, is not covered.

  An HTTP error response whose body mentions `fetch failed` or `unable to
  connect` is no longer treated as a failed connection: the CLI no longer
  retries it on the port in `~/.flair/config.yaml` or reports the instance as
  unreachable.
