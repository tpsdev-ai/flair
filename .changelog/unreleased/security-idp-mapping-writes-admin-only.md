- **Through the Credential resource, only administrators and the server create an IdP identity mapping, change its kind or identity fields, or reactivate it.**

  An IdP identity mapping is a Credential row of kind `idp`. On POST, PUT and
  PATCH, a non-admin agent's write that passes the checks that run first
  (authentication, the owner checks, and the rate limit, kind validation or
  single-record body check) is refused with 403 `idp_mapping_admin_only` when
  it would create a `kind: "idp"` credential, change a credential's kind to or
  from `idp`, change an idp credential's `idpProvider` or `idpSubject`, or
  change its `status` to anything other than `revoked`. The owner checks keep
  their own 403: on PATCH and PUT the owner-field guard refuses a change to
  `principalId`, PUT refuses a body that names another principal, and PATCH,
  PUT and DELETE refuse a write to another principal's credential. A non-admin
  agent may still relabel, revoke and delete its own idp credential, and create
  its own `webauthn`, `bearer-token` and `ed25519` credentials. Administrators,
  `flair mcp enable`, `flair principal link`, and the /mcp and XAA
  just-in-time provisioners write mappings as before; the linker now reads a
  new mapping's `createdAt` immediately before sending the mapping upsert.
