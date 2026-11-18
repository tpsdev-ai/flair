- **`/mcp` holds the issuer check on each request, not only at registration.**
  When the authorization server's live issuer stops matching `FLAIR_MCP_ISSUER`,
  requests get the boot guard's named refusal and remedy instead of a generic
  `invalid_token`, and the admin Instance page reports that refusal.
