- **`flair principal link`/`unlink` and the shared provisioner re-read validated mapping fields before each write, refusing detected changes (flair#2222).**

  The checks compare Agent presence and `id`, `kind`, `principalId`,
  `idpProvider`, `idpSubject`, `status`, `label` and `createdAt` of
  principal-bearing IdP rows for the subject. `lastUsedAt` is not compared.
  Differences in valid comparison reads refuse with `mapping-changed-underneath`;
  invalid changed rows can fail earlier validation with `missing-or-invalid-credential-field`.
  Both fail closed. After refusal, the command does not roll back its insert
  and makes no Credential write. Another writer may still remove the Agent.
  The interval between the final read and write remains; no atomicity is claimed.
