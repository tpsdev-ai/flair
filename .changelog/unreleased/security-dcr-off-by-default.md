- **Dynamic client registration is now off unless an operator turns it on.**
  `POST /OAuthRegister` used to accept anonymous registrations from anyone who
  could reach the instance, gated only by a redirect-URI host match — so on a
  publicly-reachable Flair, anyone could create rows in the durable, replicated
  `OAuthClient` table, each one a `client_id` that `/OAuthAuthorize` would
  subsequently honour. It now answers `403 access_denied` by default, and the
  RFC 8414 / `/OAuthMetadata` discovery documents stop advertising a
  `registration_endpoint`, because advertising one that refuses every request is
  a discovery document that misdirects.

  **This changes behaviour for anyone relying on anonymous registration.** To
  keep it, set `FLAIR_OAUTH_DCR_TOKEN` to an initial access token of 32 to 508
  characters (RFC 7591 §3.1) and have clients present it in an
  `X-Flair-Initial-Access-Token` header. Registering clients ahead of time and
  leaving registration off is the better shape where it is workable.

  That one variable is the whole interface: there is no separate enable switch,
  so enabling registration and supplying the credential that guards it are the
  same act, and "on, and open to the internet" is not a state reachable by
  forgetting a setting. A token outside the accepted length leaves registration
  **off** rather than enabling it weakly, and says so by variable name.

  Note that registration rate limiting runs in front of this gate, so refused
  attempts spend budget and a flood against a closed endpoint is answered `429`
  rather than `403`.

  The token belongs in the process environment. `flair deploy` will not generate
  a component `.env` containing it — a deploy payload is stored in Harper's
  deployment record and replicated to every node.

  RFC 7591 presents this token as `Authorization: Bearer`, which cannot work
  here: Harper's own auth layer claims that header and answers `401` before any
  Flair code runs. Hence the dedicated header. See
  [docs/auth.md](docs/auth.md#dynamic-client-registration).
