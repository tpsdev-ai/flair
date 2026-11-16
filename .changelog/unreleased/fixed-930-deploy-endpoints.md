- **Deploy and upgrade can name separate operations and application endpoints.**

  `flair deploy` and `flair upgrade --target` take `--operations-endpoint` and
  `--application-endpoint`. `deploy_component` uses the operations endpoint.
  Migration, discovery, and verification use the application endpoint. With
  neither flag, both stay the single target URL. Before deploy, a version
  probe that fails, returns an empty or unreadable body, or JSON with no
  version string, stops the command. After `deploy_component`, that probe
  reports that the deploy was sent and the running version is unverified.
  A resource probe accepts 401 or a 200 with JSON whose row list, when present, contains only objects, and reports any other HTTP status.
