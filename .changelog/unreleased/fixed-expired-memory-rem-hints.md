- **REM now archives validTo-expired memories, making expired-memory health warnings actionable.**
  `flair rem light` and nightly maintenance retain these rows with `archived: true`
  and `archivedAt`, count them in archival stats, and clear their health warning.
  Dry runs count eligible rows without archiving them. Existing ephemeral
  `expiresAt` deletion and agent scoping are unchanged.
  HealthDetail and status show the archive command and preview flag, the enable
  command when nightly is disabled, and the last logged failure when enabled.
  Unknown scheduler state stays explicit; no next-run time is fabricated.
  Refs #2033. Refs #1503.
