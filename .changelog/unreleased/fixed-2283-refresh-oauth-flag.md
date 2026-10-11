- **`flair mcp enable --refresh-flag` corrects an instance still holding `FLAIR_MCP_OAUTH=1` without a full enable.**

  The flag re-sets that one variable to `true` in the target's process
  environment (the same env-secrets primitive `enable` uses), restarts, and
  verifies the target's and the public document's issuer — the target's own
  discovery document must advertise that issuer with the MCP token endpoint, and
  the public document read at that issuer must name the same issuer and its token
  endpoint. It does not run the IdP-credential intake nor apply CIMD changes.

  > **Heads-up:** an instance may still hold the old staged value
  > `FLAIR_MCP_OAUTH=1`; the `@harperfast/oauth` component deletes that value, so
  > its authorization server never mounts and `/mcp` has no AS behind it. Correct
  > it in place:
  >
  > ```bash
  > flair mcp enable --instance <your-public-origin> --refresh-flag
  > ```
