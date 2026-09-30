- **`flair mcp enable`'s messages no longer name `--admin-pass-file`, `--ops-url` or `mcp.enabled=false`, and a Fabric re-run completes once self-verify passes.**
  In 0.57.0 the error for a missing target admin password named an
  `--admin-pass-file` flag, and the ops-API 404 hint named `--ops-url`; the
  command has neither. The error now asks for `--admin-pass`, and the hint names
  the address the command derived from the instance URL (same host, port 9925),
  which no option overrides. The `config-block` step printed `mcp.enabled=false`;
  it now reports the `${FLAIR_MCP_OAUTH}` reference that `config.yaml` ships and
  says the step writes nothing.

  On a Fabric instance the `fabric-operator-deploy` step failed on every run, so a
  re-run after the operator's restart stopped there again. The step now runs
  self-verify against the public origin first and completes `enable` when it
  passes; otherwise it reports why and asks for a re-run with
  `--confirm-secrets-applied` after the restart. When the secrets were pushed to
  the instance, it asks for a restart instead of asking to apply the staged
  file. The Fabric summary no longer says to set `mcp.enabled: true` in
  `config.yaml` and redeploy.

  (Closes #2116)
