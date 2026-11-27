- **With a launchd plist and an unloaded job, `flair stop` re-checks the job and instance after the recorded pid exits.** ([#3090](https://github.com/tpsdev-ai/flair/issues/3090))

  > **Heads-up:** That path exits non-zero unless the re-check reads `not-loaded` and `NOT_RUNNING`.
