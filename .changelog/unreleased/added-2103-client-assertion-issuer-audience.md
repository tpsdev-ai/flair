- **The MCP client-assertion signer can use the issuer audience (RFC 7523bis), behind a switch.** The default is
  today's shape — `aud` = the token-endpoint URL, header `typ: "JWT"` — and
  `FLAIR_MCP_CLIENT_ASSERTION_AUDIENCE=issuer` (or `flair mcp token --assertion-audience issuer`) signs `aud` = the
  issuer from the authorization server's metadata document with `typ: "client-authentication+jwt"`.

  `--issuer` supplies the authorization server origin (falling back to `FLAIR_MCP_ISSUER`/`FLAIR_PUBLIC_URL`); the
  signer fetches its `/.well-known/oauth-authorization-server` document and reads `issuer` there, never from the
  token-endpoint URL. An unreadable document or issuer without an absolute HTTP URL free of query and fragment is
  refused with a message naming the switch and metadata URL. An unset or empty switch keeps the token-endpoint
  assertion; a later PR will change the default after a compatible verifier release.
