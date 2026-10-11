- **`flair doctor` and `flair deploy` self-verify now run the MCP OAuth discovery discriminator that `flair mcp enable` runs.**

  Both import it from `src/lib/mcp-enable.ts` rather than re-deriving it. It
  compares the instance's RFC 8414 discovery-document strings against an issuer
  the CLI knows independently of the document — the shipped/ambient
  `FLAIR_PUBLIC_URL` / `FLAIR_MCP_ISSUER`, plus the probed origin. A document whose
  `issuer` equals one of those and whose `token_endpoint` is that issuer's
  `/oauth/mcp/token` is a pass; the same issuer's own authorization server
  (`<issuer>/OAuthToken`) on an instance configured for MCP OAuth is a named
  failure with a remedy; an unreadable or unrecognized document is reported as
  unconfirmed, never as a pass. `flair deploy` refuses to report success when the
  instance it shipped sets `FLAIR_MCP_OAUTH` but the target's document names
  flair's own authorization server.
