- **Memory maintenance scopes its orphan-pointer sweep to the run's owner.**

  A non-admin run, and an admin run that names an agent, counts and removes only
  pointer rows whose stamped author is that agent; a pointer with an empty author
  is outside such a run. Fleet-wide admin maintenance still sweeps every pointer
  row (#2084).
