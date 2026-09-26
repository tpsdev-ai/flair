- **A refused Flair callback now logs once per agent, site and error class, so a later different failure is no longer silenced.**

  The plugin's bounded one-time-log path keyed refusals by the agent alone, so
  after an agent's first refusal every later one for that agent was silent —
  including a different failure, such as an HTTP 500 on a capture write after a
  missing key, which is exactly the line an operator needs. The key is now the
  agent, the callback site and the error's class: a Flair failure by its status
  (its message embeds the client-assigned memory id, so the message alone would
  make every retry look like a new failure), anything else by its name and
  truncated message. Distinct failures each log once; repeats of one do not. The
  line itself, the bounded log-once set and every refusal path are unchanged.

  (Refs #1751)
