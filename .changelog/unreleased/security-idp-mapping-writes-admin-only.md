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
  just-in-time provisioners write mappings as before; the linker now stamps a
  new mapping's `createdAt` at the mapping write.

  `flair doctor` has a new read-only **IdP mappings** check, from Harper's
  audit log, over the active mappings. It lists the rows whose retained
  history, since it last started over, shows a non-admin agent creating the
  row as a mapping or changing a mapping field. It reports as unattributed the
  rows whose retained history starts at neither a recorded creation nor an
  administrator's review re-stamp. A mapping the just-in-time provisioners or
  an administrator's Credential write create is attributed by its `createdAt`
  (the server's time, within 60 seconds of its audit entry); one the linker
  creates is attributed when the linker host's clock is within 60 seconds of
  the server's. An administrator's update that leaves `createdAt` as it was,
  such as a label edit, does not start a history over. Each finding is a
  counted issue. For rows whose ids can go in a shell command, doctor prints
  the operations-API commands that clear it: revoke the mapping, or re-stamp
  one you reviewed and keep. Otherwise it names those operations. A write made
  before the `flair-agent` Harper user existed is recorded as an
  administrator's. The check changes nothing.

  > **Heads-up:** after upgrading, run `flair doctor`. Review any mapping it
  > lists or cannot attribute, then revoke it or re-stamp it as doctor
  > describes.
