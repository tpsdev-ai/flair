- **`flair status`: the expired-`validTo` warning is grouped by agent** (#2231).
  The nightly that archives an expired row is scoped to one agent, so an
  instance-wide count can stay visible forever for an agent whose rows no
  driver archives. The warning names the agents whose rows are waiting, marks
  the local nightly driver's agent as installed and flags the rest as having no
  nightly driver, naming at most five agents and counting the remainder. The
  per-agent breakdown is carried in HealthDetail's `memories.expiredByAgent`
  and so in `flair status --json`.
