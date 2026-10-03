- **Local `flair init --skip-start` installs Harper without starting it.**
  With free ports and an empty local data directory, init installs and configures
  Harper; the default instance queues the `using-flair` seed for `flair start`.
  An installed, stopped local instance is not reinstalled or started.
  Local `--skip-start` refuses `--agent` / `--agent-id`; omit them for installation
  only, then rerun init with the agent and without `--skip-start`.
  Init refuses occupied ports not attributed to this installed data directory
  before writing or sending admin credentials.
