- **`flair init` refuses unverified supplied credentials on existing installs unless `--reset-admin-pass` requests rotation (Closes #2271).**

  Without `--reset-admin-pass`, a supplied credential authenticates as `admin`
  against the admin-only `/FederationPeers` resource on a running install.
  A stopped install with an existing pass file or persisted admin user refuses
  the write; start the instance and re-run init, or use `flair init --reset-admin-pass`.
  A fresh install (no pass file and no persisted admin user) writes the supplied
  value without verification.
