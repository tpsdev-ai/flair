- **Office-wide Presence, slice 2: a spoke can push its agents' presence,
  behind a default-off flag.**
  `FLAIR_FEDERATION_PRESENCE_SEND` (default off) makes `flair federation sync`
  push the `Presence` rows of agents homed on this instance to its hub, after
  the `Memory`, `Soul`, `Agent` and `Relationship` tables. `Presence` has no
  `updatedAt`, so its rows are selected by their own `lastHeartbeatAt` /
  `activityUpdatedAt` cursor against a per-table watermark kept on the local
  `Peer` row (`presenceLastSyncAt`); only rows whose `originatorInstanceId` is
  this instance are sent, and only a confirmed batch advances the watermark. An
  admin `put()` that changes a declared field without advancing either
  timestamp waits for the agent's next heartbeat. With the flag off the sender
  behaves exactly as before.
