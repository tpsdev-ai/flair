- **Deploy and upgrade can name separate operations and application endpoints.**

  `flair deploy` and `flair upgrade --target` take `--operations-endpoint` and
  `--application-endpoint`. `deploy_component` uses the operations endpoint.
  Migration, discovery, and verification use the application endpoint. With
  neither flag, both stay the single target URL. A version probe that fails,
  or returns an empty or unreadable body, stops the command. A resource probe
  that returns HTTP 404 reports that status.
