- **A skill-tagged `POST /FeedMemories` write takes the id's per-memory write lock (flair#2927).**

  It now shares the ordinary feed write's serialization and outcome-unknown marker
  check, and records the marker when storage withholds its write result or its
  rollback cannot be confirmed.
