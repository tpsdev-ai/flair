- **OAuth discovery is now served at the two well-known paths clients actually
  probe.** `GET /.well-known/oauth-authorization-server` (RFC 8414) and
  `GET /.well-known/oauth-protected-resource` (RFC 9728, which the MCP
  authorization specification makes a MUST) both answer, unauthenticated, over
  CORS. Flair published a correct document only at `/OAuthMetadata` — a path
  nothing in the ecosystem asks for — and 404'd at both standard paths, so a
  spec-compliant remote MCP client could not discover an instance at all.

  The protected-resource document is also served at the RFC 9728 §3.1
  path-appended URL `/.well-known/oauth-protected-resource/mcp`, which is the
  form real MCP clients construct and the form the `/mcp` surface's own 401
  challenge points at.

  `/OAuthMetadata` is unchanged for existing callers and is now an **alias**:
  both paths return the same document from the same builder, so they cannot
  drift apart. Nothing about issuer derivation changed — set `FLAIR_PUBLIC_URL`
  on any non-loopback deployment or every advertised URL still points at the
  client's own localhost.

  No authentication behaviour changed. Basic and Ed25519 callers, and the
  response an uncredentialed request gets, are exactly as before; `/mcp` remains
  behind `FLAIR_MCP_OAUTH`, still off by default.
