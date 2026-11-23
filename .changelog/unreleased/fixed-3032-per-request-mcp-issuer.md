- **`/mcp` holds the issuer check on each request, not only at registration.**
  When the live OAuth configuration is missing, disabled, or its issuer stops
  matching `FLAIR_MCP_ISSUER`, `/mcp` requests get a named refusal and remedy,
  and the admin Instance page reports that refusal instead of the mounted URL.
  When `FLAIR_MCP_ISSUER` is set and the configuration is missing or disabled,
  the remedy names a valid OAuth provider (client ID, client secret and
  redirect URI) alongside `FLAIR_MCP_OAUTH` and `FLAIR_MCP_ISSUER`.
  The 503 response carries the OAuth wrapper's denial CORS headers. ([#3046](https://github.com/tpsdev-ai/flair/pull/3046))
