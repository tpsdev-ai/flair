- **The CLI falls back to another configured port only for connect-phase failures.** A write whose connection drops after the request was sent is now an unknown outcome, not a clean failure ([#2869](https://github.com/tpsdev-ai/flair/issues/2869)).

  The unknown-outcome error names the instance and says the write may or may not have been applied; the request is not replayed on the alternate configured port.
