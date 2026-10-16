- **The server answers a request whose target is not in canonical form with a named 400, before any other request processing.**

  A request target with a `.` or `..` path segment (raw or percent-encoded), an
  empty path segment, or a raw backslash gets
  `400 {"error":"non_canonical_request_target"}`. The request middleware's path
  decisions read the raw path exactly as it is routed, splitting it on `/`
  before decoding a segment. Record ids containing reserved characters, sent
  percent-encoded as Flair's clients send them (`%2F`, `%5C`), keep working.
  `flair federation pair` strips trailing slashes from the hub URL before using
  or storing it, so its requests never carry an empty path segment.
