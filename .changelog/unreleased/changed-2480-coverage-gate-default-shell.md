- **The CI workflow coverage-gate checker refuses a gate whose step, job or workflow overrides the shell.**

  A shell override can change execution semantics. A step-level `shell:`, a
  job-level `defaults.run.shell` and a workflow-level `defaults.run.shell` are
  each refused. Fixtures under `test/fixtures/workflow-gate/` cover each
  refusal.
