- **`flair agent remove` fails when the agent's Soul rows cannot be confirmed gone, instead of reporting a completed removal (Closes #2351).**

  The command now scans the agent's Soul rows before it deletes anything: a scan
  that fails or returns an unexpected response stops the removal, as the Memory
  scan already does. After the row deletes are accepted it reads the agent's Soul
  rows again. If that read fails or finds rows still stored, the command fails,
  names the Soul ids, and leaves the Agent record in place.
