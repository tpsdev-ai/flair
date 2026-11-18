- **`/mcp` holds the issuer check on each request, not only at registration.**
  When the live OAuth configuration is missing, disabled, or its issuer stops
  matching `FLAIR_MCP_ISSUER`, `/mcp` requests get a named refusal and remedy,
  and the admin Instance page reports that refusal instead of the mounted URL.
  For a missing or disabled configuration the remedy names a valid OAuth
  provider (client ID, client secret and redirect URI) alongside
  `FLAIR_MCP_OAUTH` and `FLAIR_MCP_ISSUER`.
