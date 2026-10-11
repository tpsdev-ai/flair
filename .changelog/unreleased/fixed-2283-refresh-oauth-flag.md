- **`flair mcp enable --refresh-flag` pushes an encrypted flag update and checks restart and discovery metadata.**

  It pushes an encrypted `FLAIR_MCP_OAUTH=true` update, checks the secret row's
  `processEnv` marker, verifies a restart by PID change, and checks metadata —
  the target's own discovery document must advertise that issuer with the MCP
  token endpoint, and
  the public document read at that issuer must match the same normalized issuer and its token
  endpoint. It does not run the IdP-credential intake nor apply CIMD changes.

  > **Heads-up:** an instance may still hold the old staged value
  > `FLAIR_MCP_OAUTH=1`; the `@harperfast/oauth` component deletes that value, so
  > its MCP AS remains disabled. Correct it in place:
  >
  > ```bash
  > flair mcp enable --instance <your-public-origin> --refresh-flag
  > ```
