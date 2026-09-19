- **Flair's URL builders now share one parser for the `HTTP_PORT` value.** They
  accept a bare port or a host-qualified `host:port`, so none can render a
  malformed URL when the environment carries the qualified form.

  Also aligns `embedding-stamp` with the other builders: its loopback fallback
  now uses the current default port (19926) rather than the legacy early-install
  9926, and it honours `FLAIR_PUBLIC_URL`.
