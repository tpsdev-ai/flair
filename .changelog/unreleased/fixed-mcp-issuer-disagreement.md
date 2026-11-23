- **A configured MCP issuer that differs from FLAIR_MCP_ISSUER now stops /mcp from mounting, with a remedy, instead of mounting with tokens that cannot verify.**

  The shipped `mcp.issuer: ${FLAIR_MCP_ISSUER}` form is unaffected, and a
  trailing slash alone is not a difference. ([#3034](https://github.com/tpsdev-ai/flair/pull/3034))
