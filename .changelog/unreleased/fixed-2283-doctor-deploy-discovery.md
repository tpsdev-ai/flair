- **`flair doctor` and `flair deploy` self-verify now run the MCP OAuth discovery discriminator that `flair mcp enable` runs.**

  Both import it from `src/lib/mcp-enable.ts` rather than re-deriving it, so they
  share the endpoint comparison. Doctor reports which authorization server
  answers the instance's RFC 8414 document: the MCP plugin
  (`<issuer>/oauth/mcp/token`) is a pass; flair's own authorization server
  (`<issuer>/OAuthToken`) on an instance configured for MCP OAuth is a named
  failure with a remedy; an unreadable or unrecognized document is reported as
  unconfirmed, never as a pass. `flair deploy` refuses to report success when the
  instance it shipped sets `FLAIR_MCP_OAUTH` but the target serves flair's own
  authorization server.
