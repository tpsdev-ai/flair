- **Integrity custody serializes commits, tombstones and recovery on one lock.**

  Generation commits and tombstones stage an intent marker before publication.
  Open refuses retained generation entries without CURRENT, and refuses a
  symlinked generation under its correct name. New custody refuses an existing
  registry instead of replacing it (#971).
