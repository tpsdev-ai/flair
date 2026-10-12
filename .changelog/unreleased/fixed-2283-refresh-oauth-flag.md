- **`flair mcp enable --refresh-flag` attempts an encrypted flag update and checks restart and discovery metadata.**

  It ATTEMPTS an encrypted
  `FLAIR_MCP_OAUTH=true` push: it probes the target's secrets capability, and only
  when the target can take the secret does it push the update, check the secret
  row's `processEnv` marker, verify a restart by PID change, and check metadata —
  the target's own discovery document must advertise that issuer with the MCP
  token endpoint, and
  the public document read at that issuer must match the same normalized issuer and its token
  endpoint. When the update could not be pushed or confirmed — a failed capability
  probe, a failed push, or a push whose read-back could not confirm it — it writes its
  OWN 0600 one-var file, a
  path distinct from
  `mcp enable`'s, written only when the update could not be pushed or confirmed, so
  it never truncates a previously staged IdP credentials bundle. An occupied explicit
  path is refused before probing; an occupied default path is refused when the fallback
  is needed — in both cases by name rather than truncated (the writer opens
  exclusively). It leaves a file when it can create one; an occupied path is refused
  and no file is written. It exits
  non-zero. It does not run the IdP-credential intake nor apply
  CIMD changes.

  > **Heads-up:** an instance may still hold the old staged value
  > `FLAIR_MCP_OAUTH=1`; the `@harperfast/oauth` component deletes that value, so
  > its MCP AS remains disabled. Correct it in place with a command that ATTEMPTS
  > the encrypted push — when the update could not be pushed or confirmed, it
  > leaves a file when it can create one; an occupied path is refused and no file
  > is written, and it exits non-zero:
  >
  > ```bash
  > flair mcp enable --instance <your-public-origin> --refresh-flag
  > ```
