- **Turning on MCP OAuth without the authorization-server component now logs a visible error at boot.**
  Enabling MCP OAuth is two steps, and the guard tells you the second one. `FLAIR_MCP_OAUTH=on`
  requires the `@harperfast/oauth` component, which ships commented out in `config.yaml` so it loads
  only on instances that use it. Turn the flag on without uncommenting and flair logs an error at
  boot naming the flag, the missing component, and the exact YAML to uncomment, and records the
  surface as not mounted (visible on the admin Instance page). The guard does not stop the boot — an
  optional feature must not deny service to the core one. Previously the flag could be on with the
  component absent and flair booted without error while `/mcp` silently rejected every request
  (#1021).
