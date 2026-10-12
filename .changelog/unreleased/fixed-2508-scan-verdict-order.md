- **An embedding-space scan that finishes after a newer one no longer overwrites the newer scan's verdict (#2508).**

  Scans can overlap because the explicit re-scan path calls `scan()` directly
  instead of going through the latch that serialises consult-time scans. Each
  scan now records the next sequence number when it starts, and a stale scan
  whose number a published newer scan supersedes refuses its write by name and
  changes nothing. The foreign-stamp write epoch of #2481 is unchanged.
