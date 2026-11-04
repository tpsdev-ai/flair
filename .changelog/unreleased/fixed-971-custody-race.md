- **Integrity custody serializes commits, tombstones and recovery on one lock.**

  Generation commits and tombstones stage an intent marker before publication.
  Open refuses retained generation entries without CURRENT (#971).
