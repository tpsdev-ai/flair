- **The `Integration Tests` CI job now runs as three parallel shards behind the same required check.** Each shard runs the same steps on its share of `test/integration/*.test.ts`, assigned by `scripts/ci/integration-shards.mjs`; a final job named `Integration Tests` fails unless every shard succeeds.

  (Closes #2149, #2131)
