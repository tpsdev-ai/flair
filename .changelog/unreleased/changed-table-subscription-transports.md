- **The table-subscription policy applies to every subscription transport, to publish and to retained publish.**
  On a table topic, MQTT SUBSCRIBE (`<Table>/#` or `<Table>/<id>`), PUBLISH,
  retained PUBLISH (which writes or deletes the row) and a session's last-will
  follow the same rule as SSE and WebSocket subscriptions: administrators and
  trusted internal callers only. UNSUBSCRIBE, which only ends a subscription the
  session holds, is not guarded. Over MQTT 5 a refused SUBSCRIBE gets SUBACK
  `0x87` for a verified non-admin agent and `0x80` for a caller without a valid
  credential whose session Harper admits (Harper may instead refuse it at
  CONNECT). A refused PUBLISH at QoS 1 or 2 gets the same codes on PUBACK or
  PUBREC, with an optional reason string for a non-admin agent; a refused QoS 0
  PUBLISH gets no answer. MQTT 3.1.1 has only SUBACK `0x80`; its PUBACK cannot
  signal a refusal. A refused publish reaches no subscriber, and a refused
  retained publish leaves the row as it was. A last-will is decided when Harper
  publishes it: as its session's own publish when the session drops, and as a
  caller without a valid credential when Harper replays stored wills at a worker
  start, so a replayed will on a table topic is refused. One decision function
  decides every guarded call: each table's `connect()`, `subscribe()` and
  `publish()`, and its `put()`/`delete()` when the explicit context argument is
  an MQTT session's own or a replayed will record; to tell, the guard reads only
  the own property descriptors of that argument (no getter, no `getContext()`),
  and every other `put()`/`delete()` call then passes through with its arguments
  and keeps its write rules. A call that Harper's MQTT layer makes without an
  HTTP request (its TCP and TLS listeners) resolves, everywhere flair resolves a
  caller, as one without a valid credential, and so does a call from Harper's
  native MCP component: its `resources/subscribe`, when an operator configures
  that component, refuses every table subscription, administrators included.
  Flair's feed resources (`/FeedMemories`, `/FeedSouls`) and the BM25 index now
  read table changes in-process through `subscribeInProcess`, with their own
  subscriber rules as before.
