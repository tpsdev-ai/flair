- **A skill-tagged `POST /FeedMemories` write takes the id's per-memory write lock (flair#2927).**

  This entry point records outcome-unknown markers only for attempted Memory
  writes, when storage withholds its write result, rollback cannot be confirmed,
  or the refusal body has no readable error code.
  The live head it would close is resolved before the acquisition and included
  in the lock set; the head is resolved again under
  the locks, and a head outside that set releases and retries. `409
  skill_head_moved` is returned only if the resolved head stays outside the held
  set through the final attempt.
