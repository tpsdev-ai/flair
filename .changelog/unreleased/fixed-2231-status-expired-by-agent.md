- **`flair status`: the expired-`validTo` warning is grouped by agent** (#2231).
  The nightly that archives an expired row is scoped to one agent, so an
  instance-wide count can stay visible forever for an agent whose rows no
  driver archives. The warning names the agents whose rows are waiting — at
  most five, with the remainder counted — and marks whether the local nightly
  driver archives each. The per-agent breakdown is carried in HealthDetail's
  `memories.expiredByAgent` and so in `flair status --json`.
