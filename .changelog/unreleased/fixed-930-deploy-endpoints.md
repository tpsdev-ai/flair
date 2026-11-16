- **Deploy and upgrade can name separate operations and application endpoints.**

  `flair deploy` and `flair upgrade --target` take `--operations-endpoint` and
  `--application-endpoint`. `deploy_component` uses the operations endpoint.
  Migration, discovery, and verification use the application endpoint. With
  neither flag, both stay the single target URL. Both commands refuse the
  flags when `--target` is absent, and refuse them when the application host
  is not the operations host.

  On `flair upgrade --target`, a `/Health` read that fails, is empty or
  unreadable, has no boolean `ok`, or has a version that is not a semver
  stops the command before deploy. `flair deploy` does not do that preflight
  read. After `deploy_component`, the read requires a Flair health body
  (`ok`, `searchReady`, `buildCommit`, and a semver). A missing version, a
  version that is not a semver, or a version that is still older than the
  one deployed after one re-read reports that the deploy was sent and the
  running version is unverified.

  A resource probe sends the admin Basic credential, requests one row
  (`limit=1`), and accepts a 200 whose JSON row list, when present, contains
  only objects. A body over 1048576 bytes is refused. Any other HTTP status,
  including 401, is reported. Without that credential, resource verification
  does not run.
