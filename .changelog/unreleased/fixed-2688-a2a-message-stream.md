- **A2A `message/stream` delivers the caller's OrgEvents and answers only for the caller's own agent id.**

  The stream reads the agent's OrgEvent catch-up in process with the caller's
  own identity and sends each event created after the stream opens as an
  `org.event` frame (followed by a `task.status` frame when the event carries
  a task status). A non-admin request naming another agent gets the same
  `-32001` `Forbidden` answer `message/send` gives. Polling stops when the
  client disconnects, a failed read ends the stream with one `error` frame,
  and a terminal task status ends it only for the task named in
  `params.taskId`. The stream does not move the agent's catch-up watermark.
  docs/api-reference.md now lists the A2A methods, including that `tasks/list`
  returns the instance's whole task board to any authenticated caller (#2688).
