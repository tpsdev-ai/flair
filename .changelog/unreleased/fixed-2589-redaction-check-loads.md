- **The macOS launchd lane's diagnostics redaction check loads without a build
  step, reports a crash as a crash, and runs on every PR targeting main.**

  The credential-key list it needs moves to a dependency-free module, so plain
  `node` loads the check without the compiled `dist/`. `--check` now exits `2`
  when it cannot run, which the lane reports as "redaction check could not run"
  with the exit code, distinct from a credential finding.
