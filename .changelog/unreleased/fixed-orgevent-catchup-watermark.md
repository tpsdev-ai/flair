- **Per-agent OrgEvent catch-up watermark stops silent drops past the old window and cap of 10.** Directed messages after the last ack are paged until drained; bootstrap uses the same cursor and reports `eventsHasMore` when a display cap still applies (flair#931).

  `GET /OrgEventCatchup/{id}` no longer requires `since`. The durable cursor is a monotonic event position (`createdAt` + `id`), not a wall-clock window. Advance is on explicit ack (`POST /OrgEventCatchup/{id}` with `{ position }`, or `POST /AgentReadPosition/{id}`) so a crash between deliver and ack re-delivers (at-least-once). First watermark is a 24h backfill; set `FLAIR_CATCHUP_BACKFILL_MS=0` for Flint's "now".

  > **Heads-up:** catch-up now returns `{ events, watermark, after, nextAfter, hasMore, pageSize }` instead of a bare array. Page with `after` until `hasMore` is false, then ack `nextAfter`. Callers that already read `data.events` keep working (A2A already did).
