- **With a launchd plist and an unloaded job, `flair stop` re-checks the job and instance after the recorded pid exits.** An unconfirmed stop prints what the launchd job and the instance now read, adds the instance's detail when it reads `DISAGREEMENT` or `UNKNOWN`, and names the next step. ([#3092](https://github.com/tpsdev-ai/flair/pull/3092), [#3112](https://github.com/tpsdev-ai/flair/pull/3112))

  > **Heads-up:** That path exits non-zero unless the re-check reads `not-loaded` and `NOT_RUNNING`.
