- **`flair_catchup` lets a running agent drain and ack its own org event feed.**
  The stdio adapter (`@tpsdev-ai/flair-mcp`) gains an owner-scoped tool for the
  direct-crew-comms path: it pages `GET /OrgEventCatchup/{caller}` — directed and
  broadcast `OrgEvent`s after the caller's durable watermark — and advances that
  watermark with `POST /OrgEventCatchup/{caller}` (flair#1583). Identity is the
  same Ed25519 signature every other MCP write uses; the request body never
  carries an `agentId`, and the tool refuses to read any feed but the caller's
  own.

  At-least-once by contract: `ack` is monotonic, so an event may be delivered
  twice (re-delivery is safe), an acked event does not re-deliver, and an
  un-acked event survives a restart. `after` / `limit` page a drain; `ack` —
  passed the last processed position, or a drained page's `nextAfter` — advances
  the watermark.

  > **Heads-up:** `flair_catchup` ships on the stdio adapter only
  > (`native: false`). The native `/mcp` surface still delivers events through
  > `bootstrap` (`maxEvents` / `eventsHasMore`). This is one slice of #1583 — it
  > does not close it.
