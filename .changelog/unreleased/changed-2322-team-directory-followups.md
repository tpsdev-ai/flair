- **Team directory entries declare their home instance; `Integration.patch` answers 404 for an absent row.**
  The `team_directory` entry contract now requires `homeInstanceId`, and the
  documented `Peer.status` CLI vocabulary is pinned to the federation schema.
  An `Integration.patch` addressed at a row that is not there returns
  `NOT_FOUND` instead of reaching the base table — deliberate and fail-closed
  (flair#2322).
