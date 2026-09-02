- **Socket.dev repo config added (`socket.yml`).** The Socket GitHub App's pull-request
  alerts, project reports and dependency overview are now enabled from the repository,
  ignore paths are explicit, and no user is exempt. Alert *actions* (block/warn) are
  not expressible in this file; they live in the org Security Policy and are enforced
  by the `main` ruleset requiring the "Socket Security: Pull Request Alerts" check.
