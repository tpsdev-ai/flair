- **The launchd redaction check loads without a build, runs on PRs targeting
  main, and tells a check that could not run from a finding.** (#2590)

  The credential-key list moves to a dependency-free module. When `--report`
  is supplied, completed `--check` scans write JSON finding records. The shared
  helper pairs scanner status with a valid report, returning clean, finding or
  could-not-run; startup exit `1` without a report is could-not-run. The fixture
  script requires clean and finding statuses for its respective fixtures.
  `--check` requires a target path.
