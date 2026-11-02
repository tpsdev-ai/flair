- **The CLI falls back to another configured port only for connect-phase failures.** ([#2869](https://github.com/tpsdev-ai/flair/issues/2869))

  The unknown-outcome error names the instance and says the write may or may not have been applied; the request is not replayed on the alternate configured port. When another port is configured for the fallback, a write refuses a redirect instead of following it.
