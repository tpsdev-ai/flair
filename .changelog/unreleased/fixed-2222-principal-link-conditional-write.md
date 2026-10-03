- **`flair principal link`/`unlink` and the shared provisioner re-read validated mapping fields before each write, refusing detected changes (flair#2222).**

  The checks compare Agent presence and `id`, `kind`, `principalId`,
  `idpProvider`, `idpSubject`, `status`, `label` and `createdAt` of
  principal-bearing IdP rows for the subject. `lastUsedAt` is not compared.
  A detected change refuses the pending write with `mapping-changed-underneath`.
  An Agent already inserted is retained; rollback could delete a concurrently
  adopted principal. No Credential write follows the refusal.
  The interval between the final read and write remains; no atomicity is claimed.
