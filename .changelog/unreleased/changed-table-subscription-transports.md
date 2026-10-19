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
  PUBLISH gets no answer. MQTT 3.1.1 has only SUBACK `0x80`; its PUBACK carries
  no reason code, so a PUBACK alone cannot tell a refused PUBLISH from an
  accepted one. A refused publish reaches no subscriber, and a refused retained
  publish leaves the row as it was. A last-will is decided when Harper publishes
  it: as its session's own publish when the session drops, and as a caller
  without a valid credential when Harper replays the eligible stored wills at a
  worker start (Harper drops an expired scoped-token will before this guard), so
  a replayed will on a table topic is refused. The guard decides the contexts
  Harper may take from a guarded call's arguments, read as Harper reads them —
  every listed reading for `connect()`, `subscribe()` and `publish()`, every
  marked candidate for `put()`/`delete()` — and all must be admitted. For each
  it resolves the caller, except a replayed will record, which is decided as a
  caller without a valid credential without calling the resolver; a resolved
  caller is decided by one shared policy function, and a caller that cannot be
  resolved is refused directly. The guarded calls are each table's `connect()`,
  `subscribe()` and `publish()`, and its `put()`/`delete()` when an argument
  Harper may take as the context carries the markers of an MQTT session's
  context or a replayed will record; every other `put()`/`delete()` call passes
  through with its arguments and keeps its write rules. The guard's boundary is
  protocol-layer callers, whose contexts Harper constructs; in-process code is
  trusted, and the guard makes no claim about objects an in-process caller
  crafts. A call that Harper's MQTT layer makes without an HTTP request (its TCP
  and TLS listeners) resolves, everywhere flair resolves a caller, as one
  without a valid credential, and so does a call from Harper's native MCP
  component: its `resources/subscribe`, when an operator configures that
  component, refuses every table subscription, administrators included. Flair's
  feed resources (`/FeedMemories`, `/FeedSouls`) and the BM25 index now read
  table changes in-process through `subscribeInProcess`, with their own
  subscriber rules as before.
