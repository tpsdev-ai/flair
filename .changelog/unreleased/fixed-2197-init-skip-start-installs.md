- **Local `flair init --skip-start` installs Harper without starting it.**
  With free ports and an empty local data directory, init installs and configures
  Harper; the default instance queues the `using-flair` seed for `flair start`.
  An installed, stopped local instance is not reinstalled or started.
  Without `--agent`, unattributed HTTP or operations listeners are refused.
  With `--agent` / `--agent-id`, local keys and client configuration are written;
  registration is deferred until init runs without `--skip-start`.
