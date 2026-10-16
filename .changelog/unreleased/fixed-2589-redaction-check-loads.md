- **The launchd redaction check loads without a build, runs on PRs targeting
  main, and tells a check that could not run from a finding.**

  The credential-key list it needs moves to a dependency-free module, so plain
  `node` loads the check without the compiled `dist/`. `--check` now writes its
  finding records as JSON to the file named by `--report`, a channel of its own,
  and exits `2` when it cannot run; the lane reports that as "redaction check
  could not run" with the exit code. The lane and the fixture script call an
  exit `1` a credential finding only when that report holds a well-formed
  finding record; a scanner that crashes before it scans — a startup syntax
  error, say, which exits `1` and prints its offending source line — is
  could-not-run, not a finding.
