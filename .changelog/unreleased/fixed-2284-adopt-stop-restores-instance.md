- **Failed adoption after a confirmed process exit attempts restoration and reports its outcome.**
  Restoration re-checks the port and attempts a direct restart only when the health probe reports connection refusal.
  No restart is attempted when exit was not confirmed before the stop deadline (flair#2284).
