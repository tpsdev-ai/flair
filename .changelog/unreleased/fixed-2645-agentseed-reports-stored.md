- **An AgentSeed reports the stored Agent and Soul rows, not its own staged write.**

  For attempted creates, `created` / `soulCreated` mean the stored row matches
  every field of this seed's staged row, including generated timestamps and Soul
  provenance. Otherwise, including an independent concurrent seed with the same
  input but different generated fields, or an entry found before staging,
  `alreadyExisted` / `soulAlreadyExisted` apply; the response does not claim a write
  that may not have landed (#2645).
