- **The launchd redaction check loads without a build, runs on PRs targeting
  main, and tells a check that could not run from a finding.**

  The credential-key list it needs moves to a dependency-free module, so plain
  `node` loads the check without the compiled `dist/`. `--check` now writes its
  finding records as JSON to the file named by `--report`, a channel of its own,
  and exits `2` when it cannot run; the lane reports that as "redaction check
  could not run" with the exit code. The lane and fixture script accept exit
  `0` only with a valid empty-findings report and exit `1` only with a valid
  non-empty report; all other outcomes fail as could-not-run. `--check` requires
  a target path.
