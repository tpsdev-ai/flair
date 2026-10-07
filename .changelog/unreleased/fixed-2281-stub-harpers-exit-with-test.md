- **A stub Harper started by the launchd-2040 test now exits once the test process that started it is gone.**
  A tool timeout, Ctrl-C or a CI step timeout kills the test runner, so the file's
  `afterEach` does not run. The stub watches a pid the test owns and carries a fixed
  maximum lifetime, so it no longer survives as an orphan after its tree is deleted
  (flair#2281).
