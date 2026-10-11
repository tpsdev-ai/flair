- **`flair mcp enable --refresh-flag` attempts an encrypted flag update and checks restart and discovery metadata.**

  It ATTEMPTS an encrypted
  `FLAIR_MCP_OAUTH=true` push: it probes the target's secrets capability, and only
  when the target can take the secret does it push the update, check the secret
  row's `processEnv` marker, verify a restart by PID change, and check metadata —
  the target's own discovery document must advertise that issuer with the MCP
  token endpoint, and
  the public document read at that issuer must match the same normalized issuer and its token
  endpoint. When the target cannot take the secret (an older Harper, or no secrets
  custody on the node) it writes its OWN 0600 one-var file — a path distinct from
  `mcp enable`'s, and written only after the probe says the push will not happen, so
  it never truncates a previously staged IdP credentials bundle — leaves it for
  manual application and exits
  non-zero. An explicit `--secrets-path` that already holds a file is refused by
  name rather than truncated. It does not run the IdP-credential intake nor apply
  CIMD changes.

  > **Heads-up:** an instance may still hold the old staged value
  > `FLAIR_MCP_OAUTH=1`; the `@harperfast/oauth` component deletes that value, so
  > its MCP AS remains disabled. Correct it in place with a command that ATTEMPTS
  > the encrypted push — when the target cannot take the secret, it leaves a 0600
  > file to apply by hand and exits non-zero:
  >
  > ```bash
  > flair mcp enable --instance <your-public-origin> --refresh-flag
  > ```
