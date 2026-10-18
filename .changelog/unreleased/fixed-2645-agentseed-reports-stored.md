- **An AgentSeed reports the stored Agent and Soul rows, not its own staged write.**

  When a concurrent create of the same predictable id is the stored row, the
  seed answers `created: false` / `alreadyExisted: true` for the Agent and names
  the Soul keys in `soulAlreadyExisted` (#2645).
