- **Integration test shards are assigned by measured per-file duration (#2554).**

  Per-file weights measured from CI job logs steer the assignment, so the shards
  carry a similar measured load.
