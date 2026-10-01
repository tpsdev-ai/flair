- **The MCP client-assertion signer can use the issuer audience (RFC 7523bis), behind a switch.** The default is
  today's shape — `aud` = the token-endpoint URL, header `typ: "JWT"` — and
  `FLAIR_MCP_CLIENT_ASSERTION_AUDIENCE=issuer` (or `flair mcp token --assertion-audience issuer`) signs `aud` = the
  issuer from the authorization server's metadata document with `typ: "client-authentication+jwt"`.

  The issuer is read from the metadata document at `--issuer` (default `FLAIR_MCP_ISSUER`/`FLAIR_PUBLIC_URL`) and is
  never derived from the token-endpoint URL; a document that cannot be read, or that carries no usable issuer, is
  refused with a message naming the switch and the metadata URL. Nothing changes until the switch is set: the default
  stays the token-endpoint audience until the upstream verifier release accepts the issuer (HarperFast/oauth #245 is
  merged but not released).
