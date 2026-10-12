- **An embedding-space scan no longer reopens the latch for a foreign-stamp write it did not see (#2481).**
  A scan records a write epoch at its start and publishes its verdict only when no foreign-stamp
  write was noted during the scan.
