- **`flair mcp enable --refresh-flag` attempts an encrypted flag update and checks restart and discovery metadata.**

  It attempts an encrypted `FLAIR_MCP_OAUTH=true` update and confirms the secret
  marker. On a confirmed push, it requests a restart and checks target and
  public discovery metadata. If it cannot push and confirm the flag, it attempts
  a separate 0600 fallback file and exits non-zero. Existing destination files
  are preserved; IdP credentials and CIMD settings are not changed.

  > **Heads-up:** If an instance has `FLAIR_MCP_OAUTH=1`, run
  > `flair mcp enable --instance <your-public-origin> --refresh-flag --admin-pass <target-admin-password>`.
  > Apply any staged fallback file and restart before checking MCP OAuth status.
