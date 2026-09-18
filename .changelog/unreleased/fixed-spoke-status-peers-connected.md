- **Spoke `flair status` no longer reports `peers.connected: 0` for a hub it just pushed to.**

  `federation.peers.connected` counts peers with a recent `lastSyncAt`, not a
  live socket and not `status === "connected"`. Pairing leaves the hub peer
  `paired` with no stamp; a successful push now writes `lastSyncAt` on the
  spoke (full-row upsert) so the same arithmetic the hub already uses reports
  `connected: 1`. The JSON names `measuredBy: "lastSyncAt"`. Missing contact
  stays `unknown`, never inferred from memory `lastWrite`. (Refs #1146)

  > **Heads-up:** `federation.peers` now includes `measuredBy: "lastSyncAt"`.
  > `connected` is last-contact within 24h, not a live TCP session.
