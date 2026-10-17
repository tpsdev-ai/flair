- **The default REST request middleware answers a request whose target is not in canonical form with a named 400, before any other request processing.**

  A request target with a `.` or `..` path segment (raw or percent-encoded), an
  empty path segment, or a raw backslash gets
  `400 {"error":"non_canonical_request_target"}`. For a target that passes and
  matches a default REST route, the request middleware resolves the resource,
  record id and property through Harper's own routing, so a request that
  contains a reserved character in an id (sent percent-encoded, e.g. `%2F` or
  `%5C`) is handled by the row it routes to. `flair federation pair` strips
  trailing slashes from the hub URL before using or storing it, so a trailing
  slash does not add an empty segment to the appended route.
