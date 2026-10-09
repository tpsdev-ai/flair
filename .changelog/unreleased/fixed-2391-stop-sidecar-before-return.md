- **Stop paths attempt sidecar cleanup using the PID their exit probe observed gone.**
  Direct and launchd stop legs, including restart and upgrade's snapshot stop,
  pass that PID to cleanup instead of probing it again. Removal is best effort; unlink
  errors other than a missing file are logged (flair#2391).
