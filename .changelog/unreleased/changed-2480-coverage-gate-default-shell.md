- **The CI workflow coverage-gate checker refuses a gate whose step, job or workflow overrides the shell.** (#2567)

  A shell override can change execution semantics. A step-level `shell:`, a
  job-level `defaults.run.shell` and a workflow-level `defaults.run.shell` are
  each refused. Fixtures under `test/fixtures/workflow-gate/` cover each
  refusal.

  Gates must cover every PR targeting main: `pull_request` is required,
  `branches` is absent or exactly `[main]`, path and ignore filters are refused,
  and explicit `types` must include `opened`, `synchronize` and `reopened`.
  Every gate job must be directly result-checked by the pinned adapter.
