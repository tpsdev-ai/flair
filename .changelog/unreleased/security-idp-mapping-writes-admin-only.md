- **Through the Credential resource, only administrators and the server create an IdP identity mapping, change its kind or identity fields, or reactivate it.**

  An IdP identity mapping is a Credential row of kind `idp`. On POST, PUT and
  PATCH, a non-admin agent's write is refused with 403
  `idp_mapping_admin_only` when it would create a `kind: "idp"` credential,
  change a credential's kind to or from `idp`, change an idp credential's
  `idpProvider` or `idpSubject`, or change its `status` to anything other than
  `revoked`. The owner checks run first and keep their own 403: on PATCH and
  PUT the owner-field guard refuses a change to `principalId`, PUT refuses a
  body that names another principal, and PATCH, PUT and DELETE refuse a write
  to another principal's credential. A non-admin agent may still relabel,
  revoke and delete its own idp credential, and create its own `webauthn`,
  `bearer-token` and `ed25519` credentials. Administrators, `flair mcp enable`,
  `flair principal link`, and the /mcp and XAA just-in-time provisioners write
  mappings as before.

  `flair doctor` has a new read-only **IdP mappings** check, from Harper's
  audit log, over the active mappings. It lists the rows whose retained
  history shows a non-admin agent creating the row as a mapping or changing a
  mapping field, and it reports as unattributed the rows whose retained
  history does not show the write that created them. A mapping created by
  `flair mcp enable`, `flair principal link`, the just-in-time provisioners
  or an administrator's Credential write is attributed: each stamps
  `createdAt` within 60 seconds of its audit entry. A row is unattributed when
  its creation is older than `logging.auditRetention` (3 days by default), was
  written by a cluster base copy, or carries an older `createdAt`. Each finding
  is a counted issue, and doctor prints the operations-API commands that clear
  it: revoke the mapping, or re-stamp one you reviewed and keep. A write made
  before the `flair-agent` Harper user existed is recorded as an
  administrator's. The check changes nothing.

  > **Heads-up:** after upgrading, run `flair doctor`. Review any mapping it
  > lists or cannot attribute, then run the revoke or re-stamp command it
  > prints for that row.
