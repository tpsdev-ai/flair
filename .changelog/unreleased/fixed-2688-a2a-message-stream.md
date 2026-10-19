- **A2A `message/stream` delivers OrgEvents for `params.agentId`, which a non-admin caller may set only to its own agent id.**

  The stream reads the agent's OrgEvent catch-up in process with the
  requesting caller's own identity. It sends an `org.event` frame for each
  event targeted at that agent or carrying no targets, not expired, and
  created after the stream's opening position. The opening position follows
  every event of the millisecond the stream opened. The stream keeps its own
  cursor and does not move the agent's catch-up watermark. A `task.status`
  frame follows when the existing status helper finds a status, which it may
  infer from the event's summary. A non-admin request naming another agent
  is refused with the code and message `message/send` uses (`-32001`
  `Forbidden`); the detail names the method. An admin may name another
  agent. Polling stops when the client disconnects. A read refused or failing
  while the stream is open ends it with one `error` frame, and an event for
  the task named in `params.taskId` with a terminal status ends it.
  docs/api-reference.md now lists the A2A methods. It states that the
  caller match applies to `message/send` and `message/stream` only, that an
  authenticated caller can request the unfiltered `tasks/list` board, and
  that the board comes from the YAML issue files when any exist, otherwise
  from `issues.jsonl` (#2688).
