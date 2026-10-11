- **`flair doctor` and `flair deploy` self-verify now run the MCP OAuth discovery discriminator that `flair mcp enable` runs.**

  Both import it from `src/lib/mcp-enable.ts` rather than re-deriving it. It
  compares the instance's RFC 8414 discovery-document strings against issuer(s)
  the CLI knows independently of the document — for doctor, the shipped/ambient
  `FLAIR_PUBLIC_URL` / `FLAIR_MCP_ISSUER` plus the probed origin; for deploy, the
  configured `FLAIR_PUBLIC_URL` / `FLAIR_MCP_ISSUER` read from the component `.env`
  it shipped, plus the origin it shipped to. A pass requires the document's
  normalized `issuer` to match one of those caller-known candidates and its
  `token_endpoint` to be that issuer's `/oauth/mcp/token`. A document whose `issuer`
  is one of those candidates and which advertises that issuer's `<issuer>/OAuthToken`
  is a named failure with a remedy when local configuration implies MCP OAuth is
  enabled. An unreadable or unrecognized document — including one whose issuer is no
  candidate — is reported as unconfirmed, never as a pass. When deploy verification
  is enabled, deploy fails if its shipped `.env` implies MCP OAuth is enabled and the
  document advertises flair's own token endpoint for a candidate issuer.
