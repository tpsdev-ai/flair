- **REM nightly records a deliberate non-execution as a skip, not an error, so its exit code stays 0.**
  A cycle whose distillation cannot run — no generative backend configured, an idle ADK agent, or an
  operator pause — now completes with the reason under `Skips:`; `flair doctor` no longer reports the
  REM nightly driver DEGRADED every night, and a real failure still reports `Errors:` and exits 1
  (flair#924, #1503).

  `flair status` shows `Last distilled` beside the pending-candidate count, so zero pending next to a
  distillation that has not run in nights is not rendered as a healthy zero. The run-once summary also
  labels the maintenance counts it already reported (`Archived:` validTo-expired and old sessions;
  `Expired:` ephemeral rows past `expiresAt`) (flair#1503).
