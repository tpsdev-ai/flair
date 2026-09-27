- **FlairClient refuses to send admin Basic credentials over plain http to a non-loopback host, before any request is made.**
  When no Ed25519 key resolves and `FLAIR_ADMIN_USER`/`FLAIR_ADMIN_PASSWORD` are
  set, the client previously attached an admin Basic `Authorization` header to
  whatever `FLAIR_URL` it was given — including a remote `http://` origin, where
  anyone on the path can read the password. It now parses `FLAIR_URL` and
  REFUSES (an error naming the host and the remedy: use an `https://` URL, or an
  Ed25519 key) when the scheme is `http:` and the host is not loopback
  (`localhost`, `127.0.0.0/8`, `::1`/`[::1]`), before any request is sent. https,
  loopback http, and signed (Ed25519) requests are unchanged. Every caller of
  the client — flair-mcp, langgraph-flair, pi-flair and the wake runner — is
  covered.

  (Closes #1951)
