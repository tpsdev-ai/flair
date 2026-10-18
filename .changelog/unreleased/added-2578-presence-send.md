- **Office-wide Presence, slice 2: a spoke can push its agents' presence,
  behind a default-off flag.**
  `FLAIR_FEDERATION_PRESENCE_SEND` (default off) makes `flair federation sync`
  push the `Presence` rows stamped with this instance as their
  `originatorInstanceId` to its hub, after
  the `Memory`, `Soul`, `Agent` and `Relationship` tables. `Presence` has no
  `updatedAt`, so its rows are selected by their own `lastHeartbeatAt` /
  `activityUpdatedAt` cursor against a per-table watermark (less a 30 s re-scan
  overlap) kept on the local `Peer` row (`presenceLastSyncAt`); only a confirmed
  batch advances the watermark, which never passes the time of the scan — a row dated
  more than 5 minutes ahead is not sent. An
  admin `put()` that changes a declared field without advancing either
  timestamp waits for the agent's next heartbeat. With the flag off the sender
  behaves exactly as before.
