- **Table subscription routes are served to administrators only.**
  An exported table's subscription route, SSE (`Accept: text/event-stream`) or
  WebSocket on `/<Table>/` and `/<Table>/<id>`, admits administrators (Admin
  Basic or an admin agent) and trusted internal callers. A verified non-admin
  agent is refused with 403 (WebSocket close code 3003), and a caller without a
  valid credential with 401 (close code 3000). The guard is installed on every
  table class in the database's table registry when the component loads, so a
  table added to the schema gets it without being named. Resources that are not
  tables, such as `/FeedSouls`, decide their own subscribers and are unchanged;
  verified agents receive soul changes there.

  > **Heads-up:** a client that subscribed to a table route with an agent key now
  > gets 403. Subscribe with an administrator's credential; for soul changes, a
  > verified agent can use `/FeedSouls`.
