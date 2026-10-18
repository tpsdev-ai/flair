- **Office-wide Presence, slice 2: a spoke can push its agents' presence,
  behind a default-off flag.**
  `FLAIR_FEDERATION_PRESENCE_SEND` (default off) makes `flair federation sync`
  push the `Presence` rows stamped with this instance as their
  `originatorInstanceId` to its hub, after the `Memory`, `Soul`, `Agent` and
  `Relationship` tables. `Presence` has no `updatedAt`, so its rows are
  selected by their own `lastHeartbeatAt` / `activityUpdatedAt` cursor against
  a per-table watermark, clamped to scan time, less a 30 s overlap (floor
  zero). The watermark is kept on the local `Peer` row (`presenceLastSyncAt`);
  after confirmed contact, the greater of the effective watermark and sent
  cursors is saved, clamped to scan time, but a retryable refusal or an
  indeterminate outcome holds the saved value below that row's cursor (a row
  dated more than 5 minutes ahead is not sent). With the flag off the sender
  sends no Presence records.
