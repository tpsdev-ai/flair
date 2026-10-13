- **An embedding-space scan that finishes after a newer one no longer overwrites the newer scan's verdict (#2508).**

  Scans can overlap because the boot pre-warm's re-scan path calls `scan()`
  directly instead of going through the latch that serialises consult-time
  scans. Each scan now takes a sequence number when it starts. When no
  foreign-stamp write arrived during it, a scan that finishes after a
  later-started scan has published refuses its write by name and changes
  nothing. When one did, the foreign-stamp write epoch of #2481 discards the
  scan and resets the retry timer, unchanged.
