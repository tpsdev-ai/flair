- **`flair status --json` names what `federation.peers.connected` measures.**

  The count is last-contact (`lastSyncAt` within 24h), not a live socket and
  not `status === "connected"`. #1499 already fixed the 0.40.0 spoke
  `connected: 0` (pairing never writes that status). This adds
  `measuredBy: "lastSyncAt"` and stamps the spoke's hub row only after a
  confirmed FederationSync 200 (batch or liveness ping), using completion
  time. A failed ping leaves the stamp untouched. (Refs #1146)

  > **Heads-up:** `federation.peers` now includes `measuredBy: "lastSyncAt"`.
  > `connected` is last-contact within 24h, not a live TCP session.
