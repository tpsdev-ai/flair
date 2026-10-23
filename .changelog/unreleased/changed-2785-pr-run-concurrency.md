- **Pull-request CI cancels a PR's superseded runs, and main runs keep one
  group per commit.** A second push to a pull request cancels the run started
  by the first push in each affected workflow, freeing queued runners. A run on
  main is never cancelled.
