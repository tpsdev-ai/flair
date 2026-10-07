- **The unit lane's coverage check reads its test packages from disk and requires every shard to run.**
  A `packages/*` directory with tests the plan omits, or a matrix `exclude` that
  drops a leg, now fails that check.
