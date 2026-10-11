- **`flair doctor` and `flair deploy` self-verify now run the MCP OAuth discovery discriminator that `flair mcp enable` runs.**

  Both import it from `src/lib/mcp-enable.ts` rather than re-deriving it. It
  compares the instance's RFC 8414 discovery-document strings against an issuer
  the CLI knows independently of the document — the shipped/ambient
  `FLAIR_PUBLIC_URL` / `FLAIR_MCP_ISSUER`, plus the probed origin. A document whose
  normalized `issuer` matches one of those and whose `token_endpoint` is that issuer's
  `/oauth/mcp/token` is a pass; an advertised `<issuer>/OAuthToken` is a named
  failure with a remedy when local configuration implies MCP OAuth is enabled;
  an unreadable or unrecognized document is reported as unconfirmed, never as a
  pass. When deploy verification is enabled, deploy
  fails if its shipped `.env` implies MCP OAuth is enabled but the document
  advertises flair's own token endpoint.
