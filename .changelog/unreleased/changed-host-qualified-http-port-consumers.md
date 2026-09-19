- **Flair's URL builders now share one parser for the `HTTP_PORT` value.** They
  accept a bare port or a host-qualified `host:port`, so none can render a
  malformed URL when the environment carries the qualified form.

  The parser also rejects a port outside 1–65535, so an out-of-range `HTTP_PORT`
  falls back to the default instead of handing a URL builder a value `new URL()`
  throws on. `embedding-stamp`'s loopback fallback now uses the current default
  port (19926) rather than the legacy early-install 9926.
