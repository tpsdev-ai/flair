- **`flair init` checks supplied credentials before replacing an existing admin-pass without `--reset-admin-pass` (Closes #2271).**

  Without `--reset-admin-pass`, supplied credentials are checked against
  the admin-only `/FederationPeers` resource before writes on a running install.
  A stopped `--skip-start` init can reuse an identical securely read credential.
  Other supplied credentials on stopped existing installs are refused.
  A fresh install (no pass file and no persisted admin user) writes the supplied
  value without verification.
