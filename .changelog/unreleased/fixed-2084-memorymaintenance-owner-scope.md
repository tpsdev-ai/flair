- **Memory maintenance scopes its orphan-pointer sweep to the run's owner.**

  A non-admin run, and an admin run that names an agent, considers only pointer
  rows whose stamped author is that agent; a pointer with an empty author is
  outside such a run. Fleet-wide admin maintenance considers every pointer row,
  so it also removes an empty-author orphan pointer (#2084). A dry run skips the
  sweep.

  The run counts a pointer as removed only when a read after its commit finds
  the pointer gone. A pointer replaced after the sweep's final confirmation
  read, by a write whose transaction takes its time after the sweep's first
  read, stays stored and is not counted; a write whose transaction took its time
  before that read and commits after the confirmation read is not covered.
