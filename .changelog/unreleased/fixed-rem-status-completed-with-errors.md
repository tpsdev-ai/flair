- **REM nightly no longer reports `completed` when a core stage did not run.**
  `runNightlyCycle` now marks a cycle `failed` whenever its audit row carries a
  non-empty `errors[]`, so a run whose distillation never executed (for example
  against a missing generative backend) stops logging `completed` next to a
  populated `Errors:` block. The reported status now agrees with the launchd
  exit code, which was already `1` — a service manager and `flair doctor` see
  the same signal. Surfacing defect 1 of #924; the missing backend itself is
  tracked separately (#1503). (Refs #924)
