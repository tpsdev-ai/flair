- **`flair status` no longer warns that federation peers are disconnected when a paired hub just synced.** A `paired` peer with a recent `lastSyncAt` counts as connected; missing timestamps are unknown, not stale; revoked peers do not drive the >24h warning (flair#1499).

  HealthDetail used to count only `status === "connected"` (pairing writes `paired`) and then take the oldest `lastSyncAt` including revoked rows. A healthy hub synced a minute ago plus a revoked June row printed `0 connected` and `federation peers all disconnected >24h`. Contact is now derived from a written `lastSyncAt`: within 24h → connected, older than 24h → disconnected, no stamp → unknown. The warning fires only when every non-revoked peer has a real last-contact older than 24h.

  > **Heads-up:** `federation.peers` now includes `unknown`, and admin `peerList` rows include `liveness` (`connected` / `disconnected` / `unknown` / `revoked`). Stored `status` is unchanged (`paired`, `revoked`, …).
