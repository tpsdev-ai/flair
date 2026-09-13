- **`@tpsdev-ai/flair-client` memory listing works again.** `FlairClient.memory.list()`
  previously failed and returned no memories; it now returns the agent's memories,
  with subject, tag, type, and durability filters plus ordering and limit applied
  (flair#1649).
