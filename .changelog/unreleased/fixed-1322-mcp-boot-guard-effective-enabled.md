- **Native MCP boot refuses a flag value the authorization server does not treat as enabled.** The boot guard compares Flair's reader with the component's effective `mcp.enabled`.

  > **Heads-up:** An instance enabled before 0.46 may still have `FLAIR_MCP_OAUTH=1`. When `mcp.enabled` is `${FLAIR_MCP_OAUTH}`, set `FLAIR_MCP_OAUTH=true` and restart. `1`, `yes`, and `on` do not enable `@harperfast/oauth`.
