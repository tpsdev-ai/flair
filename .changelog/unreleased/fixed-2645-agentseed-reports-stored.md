- **An AgentSeed reports the stored Agent and Soul rows, not its own staged write.**

  For attempted creates, `created` / `soulCreated` mean the stored fields match
  the seed request; `alreadyExisted` / `soulAlreadyExisted` report a different
  stored row or an entry found before staging a create. An identical concurrent
  create is indistinguishable and reports as created: the stored state is what
  the caller asked for (#2645).
