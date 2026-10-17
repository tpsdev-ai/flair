- **The memory-tool contract in openclaw-flair's manifest is now the tool-name string list the OpenClaw host reads.** (#2523)

  The host normalizes each `contracts` family to its string entries; the
  previous object entries were dropped, and the host refused `memory_search`,
  `memory_store` and `memory_get` as undeclared.
