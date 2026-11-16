- **Deploy and upgrade can name separate operations and application endpoints.**

  `flair deploy` and `flair upgrade --target` take `--operations-endpoint` and
  `--application-endpoint`. `deploy_component` uses the operations endpoint.
  Migration, discovery, and verification use the application endpoint. With
  neither flag, both stay the single target URL. Both commands refuse the
  flags when `--target` is absent, and refuse them when the application host
  is not the operations host.

  On `flair upgrade --target`, a `/Health` read that fails, is empty or
  unreadable, is not a Flair health body, or has a version that is not a
  semver stops the command before deploy. `flair deploy` does not do that
  preflight read. After `deploy_component`, a missing version, a version that
  is not a semver, or a version older than the one deployed reports that the
  deploy was sent and the running version is unverified.

  A resource probe accepts a 200 whose JSON row list, when present, contains
  only objects, and reports any other HTTP status, including 401.
