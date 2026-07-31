- **The OAuth endpoints and `/mcp` are now rate limited.** `/OAuthToken`,
  `/OAuthAuthorize` and `/OAuthRevoke` share a budget of 30 requests per minute
  per caller; `/OAuthRegister` gets 5 per five minutes; `/mcp` gets 120 per
  minute per verified token subject. A rejected request answers `429` with a
  `Retry-After`. On by default — nothing to configure — and no other path is
  affected.

  The counter is consumed before any credential is examined, so a `429` reveals
  nothing about what the request was carrying: a valid authorization code and a
  garbage one get byte-identical responses once a bucket is spent. No
  `RateLimit-*` headers are published on allowed requests.

  Tunable via `FLAIR_OAUTH_RATE_LIMIT`, `FLAIR_OAUTH_REGISTER_RATE_LIMIT` and
  `FLAIR_MCP_RATE_LIMIT`; `FLAIR_RATE_LIMIT=off` disables it entirely. A limit
  of zero, a negative number or a non-numeric value is refused in favour of the
  default, with a warning naming the variable — a shell that expanded an unset
  variable cannot quietly switch the control off.

  Keying is on the socket peer address. `X-Forwarded-For` is ignored unless
  `FLAIR_TRUSTED_PROXY` names how many proxy hops genuinely sit in front, since
  an instance that trusts that header without a proxy can be bypassed by varying
  it. **The limiter is per node**: on a multi-node deployment the effective
  ceiling is the limit times the node count, and counters reset on component
  reload. A cluster-shared counter would turn every counted request into a
  durable replicated write on an authentication hot path, which is a worse
  denial-of-service shape than the one being defended against. See
  [docs/auth.md](docs/auth.md) for what this does and does not protect against.
