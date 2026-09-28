- **Client wiring and hook repairs check the package pin they replace.**
  Unrecognized package-bearing entries are held; continuity repairs retain
  their existing pin state. Continuity commands with no package reference remain
  shape repairs, with matching doctor and hook-status advice. Package-bearing
  commands outside the writer's recognized forms report stale with held/manual
  advice instead of appearing wired. Codex wiring and doctor decode the actual
  TOML package argument, including literal/basic strings, escapes and multiline
  args, while ambiguous entries stay held. Codex pin refreshes require a
  recognized npx command with Flair as its package operand; unsupported
  invocations are held without changing the configuration. Continuity reporting
  and repairs share one package capture and the command builder's env-value
  validation.

  (Closes #1848)
