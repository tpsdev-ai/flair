- **IdP identity mappings (Credential rows of kind `idp`) are created and changed only by administrators and the server.**

  Through the Credential resource, a non-admin agent's write that would create a
  `kind: "idp"` credential, change a credential's kind to or from `idp`, or
  change an idp credential's `principalId`, `idpProvider`, `idpSubject` or
  `status` is refused with 403 `idp_mapping_admin_only`. A non-admin agent may
  still relabel or revoke its own idp credential and create its own `webauthn`,
  `bearer-token` and `ed25519` credentials. Administrators, `flair mcp enable`,
  `flair principal link`, and the /mcp and XAA just-in-time provisioners write
  mappings as before.

  `flair doctor` has a new read-only **IdP mappings** check: IdP mapping rows
  written by a non-admin agent (from the audit log). It also counts the rows it
  cannot attribute: rows with no retained audit entry (older than
  `logging.auditRetention`, 3 days by default, or copied by a cluster base copy),
  and writes made before the `flair-agent` Harper user existed, which read as an
  administrator's. It changes nothing.

  > **Heads-up:** after upgrading, run `flair doctor`. Review any mapping it lists
  > with `flair principal links <principal>`, and revoke one that should not
  > resolve with `flair principal unlink`.
