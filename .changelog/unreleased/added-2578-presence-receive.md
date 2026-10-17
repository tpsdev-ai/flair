- **Office-wide Presence, slice 1: a hub can receive a spoke's agent presence,
  behind a default-off flag.**
  `FLAIR_FEDERATION_PRESENCE_RECEIVE` (default off) lets a hub accept `Presence`
  records over the existing hub-and-spoke sync and derive status locally from the
  replicated timestamps. A record is accepted only when the local `Agent` row for
  its `agentId` is homed on the batch-verified sender: a missing `Agent` row is a
  retryable skip, and a row homed elsewhere or with no home is not. Inbound rows
  are stripped to the declared Presence fields and validated (activity
  vocabulary, a finite heartbeat within a 5-minute future allowance, version
  strings capped at 64 characters) before storage, and a Presence-specific merge
  refuses an older heartbeat rather than replacing a newer one. The local writers
  (POST, PUT, PATCH) compare the agent's home against this instance's id read
  fresh from the `Instance` table at write time, refusing a write for an agent
  homed on another instance, and none of them can set a client
  `originatorInstanceId` or `receivedAt`. `Presence`
  gains nullable `originatorInstanceId` (local creates stamp this instance's id
  read fresh from the `Instance` table, or null; updates preserve the stored
  value) and `receivedAt` (stamped on receipt).
  With the flag off, a Presence record eligible for
  receipt skips as `presence_receive_disabled` rather than `unknown_table`.
