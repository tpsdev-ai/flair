- **Native MCP boot checks the component's effective `mcp.enabled`.** When Flair's flag is on and the degraded-start check passes, the boot guard refuses registration unless that value is true and `mcp.issuer` passes the boot guard’s origin validation.

  > **Heads-up:** An installation may still have `FLAIR_MCP_OAUTH=1`. When `mcp.enabled` is `${FLAIR_MCP_OAUTH}`, set `FLAIR_MCP_OAUTH=true` and `FLAIR_MCP_ISSUER` to a bare HTTP(S) origin, then restart. `1`, `yes`, and `on` do not enable `@harperfast/oauth`. ([#2282](https://github.com/tpsdev-ai/flair/pull/2282))
