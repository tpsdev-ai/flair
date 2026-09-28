- **Expired-memory warnings now include REM cleanup and scheduler guidance.**
  HealthDetail and status show the cleanup command and preview flag, the enable
  command when nightly is disabled, and the last logged failure when enabled.
  Unknown scheduler state stays explicit; no next-run time is fabricated.
  The hint also notes that maintenance does not yet clean up rows solely because
  validTo expired. Refs #2033.
