- **The launchd redaction check loads without a build, runs on PRs targeting
  main, and tells a check that could not run from a finding.**

  The credential-key list it needs moves to a dependency-free module, so plain
  `node` loads the check without the compiled `dist/`. `--check` now exits `2`
  when it cannot run; the lane reports that as "redaction check could not run"
  with the exit code, and reports an exit `1` carrying the redactor's finding
  marker as a credential finding.
