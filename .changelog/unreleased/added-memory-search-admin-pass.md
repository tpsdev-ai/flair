- **`flair memory search --admin-pass <pass>`** — search another agent's memories as admin
  while `--agent` names whose memories to read. Callers that used to rely on the
  ambient `FLAIR_ADMIN_PASS` substituting for a keyless `--agent` now say so
  explicitly (`memory add` already had the flag).
