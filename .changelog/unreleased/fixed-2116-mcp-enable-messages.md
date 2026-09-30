- **`flair mcp enable`'s messages no longer name `--admin-pass-file`, `--ops-url` or `mcp.enabled=false`, and a Fabric re-run completes once self-verify passes.**
  In 0.57.0 the error for a missing target admin password named an
  `--admin-pass-file` flag, and the ops-API 404 hint named `--ops-url`; the
  command has neither. The error now asks for `--admin-pass`, and the hint names
  the address the command derived from the instance URL (same host, port 9925),
  which no option overrides. The `config-block` step printed `mcp.enabled=false`,
  and listed a `--cimd-allowed-hosts` value as the shipped `allowedHosts`. It now
  reports the `${FLAIR_MCP_OAUTH}` reference and the allowed hosts that
  `config.yaml` ships, says the step writes nothing, and shows a
  `--cimd-allowed-hosts` value as requested, pointing to the
  `cimd-allowed-hosts` step for whether and when the run writes it.

  On a Fabric instance the `fabric-operator-deploy` step failed on every run, so a
  re-run after the operator's restart stopped there again. The step now runs
  self-verify against the public origin first and completes `enable` when it
  passes. When a response came back but self-verify did not pass, the step
  reports why and asks for a re-run with `--confirm-secrets-applied` after the
  restart; if the run pushed the secrets to the instance, it asks for a restart
  instead of asking to apply the staged file. When the request itself fails, it
  names the URL it tried and asks the operator to check DNS, HTTPS reachability
  from this machine and that the instance is running before re-running. A run
  reaches that step only after `--confirm-secrets-applied` or a yes at the
  prompt. The Fabric summary no longer says to set `mcp.enabled: true` in
  `config.yaml` and redeploy, and asks for a restart only when the instance's
  environment changed.

  (Closes #2116)
