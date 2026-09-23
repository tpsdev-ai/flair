- **flair-client now requires an explicit identity for every action, and the last hardcoded `flint` signer is gone.**

  The signing guard no longer keys on a list of the actions that sign
  (`SIGNING_ACTIONS`), which failed open: an action added to the dispatch switch
  but not to that list would have signed with no identity at all. It is now
  deny-by-default — every action needs `FLAIR_AGENT_ID` or `--agent <id>` unless
  it is listed in an explicit `UNSIGNED` allow-list, which is empty. A test
  enumerates every action the dispatcher accepts (derived from the switch) and
  runs each one, so a new case that is neither refused nor declared unsigned
  fails the lane. `scripts/repro-resource-busy.mjs` no longer signs as a hardcoded
  `flint` from one fixed key path: it takes the same explicit identity and shares
  the client's key resolution and signing (`scripts/lib/flair-signing.mjs`).

  (Closes #1855)
