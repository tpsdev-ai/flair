- **`flair init --skip-start` installs and configures Harper without starting it.**
  On an empty data directory it now performs the same installation `flair init`
  does and stops short of starting Harper, so a later `flair start` on that
  default instance starts it and performs the first-start work (such as the
  `using-flair` seed) left queued. On an already-installed instance it does not
  install or start it.

  Previously `--skip-start` skipped Harper installation as well as the start, so
  a later `flair start` on an empty data directory had no instance to run.
