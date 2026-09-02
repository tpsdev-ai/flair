- **Socket.dev policy is now pinned in the repository (`socket.yml`).** Supply-chain
  risk, vulnerabilities and anomalies flagged on a pull request's dependency diff are
  errors; quality signals warn. Previously the repo ran Socket's default policy. No
  runtime change; accepting a legitimately flagged package is done per package in the
  Socket dashboard with a reason, not by loosening the file.
