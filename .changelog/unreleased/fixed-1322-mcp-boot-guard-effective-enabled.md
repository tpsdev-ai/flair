- **Native MCP boot checks the component's effective `mcp.enabled`.** When Flair's flag is on and the degraded-start check passes, the boot guard refuses registration unless that value is true.

  > **Heads-up:** An instance enabled before 0.46 may still have `FLAIR_MCP_OAUTH=1`. When `mcp.enabled` is `${FLAIR_MCP_OAUTH}`, set `FLAIR_MCP_OAUTH=true` and restart. `1`, `yes`, and `on` do not enable `@harperfast/oauth`.
