- **`flair-client.mjs` now requires an explicit identity for reads too — `list`,
  `get` and `search` refuse instead of signing as the shipped `flint` default.**

  Every action the script supports signs its request, so every action now
  resolves its identity from `FLAIR_AGENT_ID` or `--agent <id>` and exits
  non-zero naming both when neither is set. #1816 made mutations refuse but
  left reads on the `flint` default, so an identity-less `search` or `get` could
  return that principal's non-shared records to a caller who never chose it.
  A refused read makes no network request at all.

  > **Heads-up:** scripted reads that relied on the default identity now fail
  > closed — set `FLAIR_AGENT_ID` or pass `--agent <id>` at those call sites.

  (Closes #1851)
