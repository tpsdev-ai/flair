- **The plain-tree upgrade lane test is now gated to Linux, so it no longer fails the macOS release cut.**

  `test/unit/upgrade-plain-tree-ci-lane.test.ts` exercises the **systemd** spoke ritual —
  deliberately the non-launchd path, which has its own lane in
  `scripts/ci/macos-launchd-upgrade-lane.sh`. It carried no platform gate, so on macOS the
  script correctly reported `no systemd unit found`, exited 1, and failed the test. Nothing
  noticed in CI, which is Linux; it surfaced only in `release.sh`, whose full unit suite runs
  on the macOS release host. The systemd case is now `test.skipIf(process.platform !== "linux")`
  — a reported skip rather than an omission, per the rule `scripts/check-darwin-gated-tests.mjs`
  enforces. The "script is present" case is platform-independent and still runs everywhere.

  This is flair#1012 inverted: that issue covers darwin-gated tests no CI lane executes, and
  darwin gates are policed by an inventory script. There is no equivalent inventory for Linux
  gates, which is how an ungated systemd test reached main.
