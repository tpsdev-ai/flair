- **Table subscription routes are served to administrators only.**
  Every table's own subscription route, SSE (`Accept: text/event-stream`) or
  WebSocket on `/<Table>/` and `/<Table>/<id>`, admits administrators (Admin
  Basic or an admin agent) and trusted internal callers. A verified non-admin
  agent is refused with 403 (WebSocket close code 3003), and a caller without a
  valid credential with 401 (close code 3000). The rule is applied to every
  table in the flair database when the component loads, so a table added to the
  schema is covered without being named. Agents subscribe through the feed
  resources, `/FeedMemories` and `/FeedSouls`, which are not tables and are
  unchanged.

  > **Heads-up:** a client that subscribed to a table route with an agent key now
  > gets 403. Subscribe through `/FeedMemories` or `/FeedSouls`, or with an
  > administrator's credential.
