- **`flair mcp enable --refresh-flag` corrects an instance still holding `FLAIR_MCP_OAUTH=1` without a full enable.**

  The flag re-sets that one variable to `true` in the target's process
  environment (the same env-secrets primitive `enable` uses), restarts, and
  confirms the MCP authorization server answers, using the same discovery check
  as `flair doctor` and `flair deploy`. It does not re-run the IdP credential
  intake or the identity mapping.

  > **Heads-up:** an instance enabled before 0.46.0 holds `FLAIR_MCP_OAUTH=1`;
  > the `@harperfast/oauth` component deletes that value, so its authorization
  > server never mounts and `/mcp` has no AS behind it. Correct it in place:
  >
  > ```bash
  > flair mcp enable --instance <your-public-origin> --refresh-flag
  > ```
