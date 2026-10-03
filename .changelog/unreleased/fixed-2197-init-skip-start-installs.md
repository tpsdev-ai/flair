- **`flair init --skip-start` installs and configures Harper without starting it.**
  On an empty data directory it now performs the same installation `flair init`
  does and stops short of starting Harper, so a later `flair start` starts the
  instance; first-start work such as the `using-flair` seed stays queued until
  then. On an already-installed instance it leaves the instance unchanged.

  Previously `--skip-start` skipped Harper installation as well as the start, so
  on an empty data directory a later `flair start` had no instance to run and
  anything deferred to first start never happened.
