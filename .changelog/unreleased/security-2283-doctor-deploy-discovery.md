- **`flair doctor` and `flair deploy` self-verify now run the MCP OAuth discovery discriminator that `flair mcp enable` runs.**

  Both commands compare MCP OAuth discovery with an issuer and endpoint known
  independently of the metadata. Unreachable or unrecognized metadata is
  reported as unconfirmed. A recognized mismatch is an error when configuration
  implies MCP OAuth is enabled; deploy verification fails.
