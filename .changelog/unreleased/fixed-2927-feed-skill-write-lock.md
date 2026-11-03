- **A skill-tagged `POST /FeedMemories` write takes the id's per-memory write lock (flair#2927).**

  It now shares the ordinary feed write's serialization and outcome-unknown marker
  check, and records the marker when storage withholds its write result or its
  rollback cannot be confirmed. The live head it would close is resolved before
  the acquisition and included in the lock set; the head is resolved again under
  the locks, and a head outside that set releases and retries. `409
  skill_head_moved` is returned only if the resolved head stays outside the held
  set through the final attempt.
