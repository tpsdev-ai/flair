- **The CI workflow coverage-gate checker compares the Unit Tests adapter step line by line.**

  A script whose `exit 1` is joined onto the preceding `echo` makes it an
  argument to `echo`, so the branch returns 0 instead of terminating the
  script, and a failed unit job can be reported as a success. Each adapter
  command must now be on its own line; indentation and trailing whitespace are
  still accepted. A fixture under `test/fixtures/workflow-gate/` covers the
  refusal.
