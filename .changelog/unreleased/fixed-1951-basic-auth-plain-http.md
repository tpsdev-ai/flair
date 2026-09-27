- **FlairClient refuses to send admin Basic credentials over plain http to a non-loopback host, before any request is made.**
  When no Ed25519 key resolves and `FLAIR_ADMIN_USER`/`FLAIR_ADMIN_PASSWORD` are
  set, the client attaches an admin Basic `Authorization` header. It now checks
  the URL the request will actually go to, and refuses (an error naming a remedy,
  and the host when both FLAIR_URL and the request URL parse) when that URL's scheme
  is `http:` and its host is not loopback (`localhost`, `127.0.0.0/8`, `::1`), when
  it cannot be parsed, or when its host differs from `FLAIR_URL`'s. A request path
  must start with `/`. https, loopback http, and signed (Ed25519) requests are
  otherwise unchanged. This covers every package that sends through FlairClient
  (flair-mcp, langgraph-flair, pi-flair, the wake runner, the n8n nodes, and
  openclaw-flair, which only signs). Admin requests that do not go through
  FlairClient (n8n's credential test, CLI admin commands) are not covered by this
  change.

  (Closes #1951)
