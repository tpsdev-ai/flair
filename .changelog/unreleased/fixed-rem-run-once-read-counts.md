- **`flair rem nightly run-once` prints `Memories:` and `Souls:` as `unknown (<reason>)` when that read fails, not as `0`.**
  A failed read is listed under `Errors:` and the run reports failed; a successful read prints its exact count. ([#2753](https://github.com/tpsdev-ai/flair/pull/2753))
