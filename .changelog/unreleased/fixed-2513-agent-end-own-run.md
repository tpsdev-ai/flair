- **`agent_end` stamps a message with the id of the run that produced it and stops re-storing what earlier runs already captured (#2513).**

  `agent_end` receives the whole session's message snapshot. The previous release
  scanned the whole snapshot on each run, so later runs stored duplicates of
  earlier messages under new memory ids, attributed to the wrong run. The capture
  path now tracks, per session, how many snapshot messages an earlier run already
  accounted for, and stamps the run id on the messages past that mark.
