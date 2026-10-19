- **The table-subscription policy applies to every subscription transport, to publish and to retained publish.**
  Table subscriptions over MQTT (SUBSCRIBE on `<Table>/#` or `<Table>/<id>`),
  table publishes, and retained publishes (which write or delete the row)
  follow the same rule as SSE and WebSocket subscriptions: administrators and
  trusted internal callers only. A verified non-admin agent gets reason code
  `0x87`; a caller without a valid credential is refused at CONNECT, or gets
  `0x80` when Harper admits its session. A refused publish reaches no
  subscriber, and a refused retained publish leaves the row as it was. One
  decision function decides every guarded call: each table's `connect()`,
  `subscribe()` and `publish()`, and its `put()`/`delete()` when an MQTT
  session makes the call; other `put()`/`delete()` calls pass through without
  resolving a caller and keep their write rules. A call that Harper's MQTT
  layer makes without an HTTP request (its TCP and TLS listeners) resolves,
  everywhere flair resolves a caller, as one without a valid credential.
  Flair's feed resources (`/FeedMemories`, `/FeedSouls`) and the BM25 index
  read table changes in-process and are unchanged.
