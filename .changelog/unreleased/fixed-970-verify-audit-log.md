- **`flair doctor` and `flair init` now verify the Harper audit log actually
  records — silent non-recording can no longer look like a pass.** Both
  commands run a positive control: write two ephemeral probe rows'-worth of
  changes (PUT + PATCH), read the audit trail back via `read_audit_log`, and
  assert both write entries are present. A node whose audit log is enabled but
  empty — the state a cluster base-copy/resync produces, where `describe_table`
  still reports `audit: true` and `read_audit_log` answers clean empty —
  previously went entirely unchecked. Classification: entries present reports
  "recording (verified now)" (a present-tense claim only — the probe proves
  current recording, never historical completeness); enabled-but-missing
  entries reports NOT RECORDING with the base-copy caveat (audit history has a
  hard start boundary at copy time on a resynced node); `read_audit_log`
  rejecting with HTTP 400 reports DISABLED with the remedy (`logging.auditLog`
  in the root `harperdb-config.yaml`, not flair's component `config.yaml`);
  and an unprobeable instance (unreachable ops API, no agent key, no admin
  credential) renders UNVERIFIED — an unrun check must not look like a pass.
  The probe row is ephemeral (TTL backstop), deleted best-effort after the
  read, and all assertions are boolean — audit-entry content is never echoed
  into command output. (flair#970)
