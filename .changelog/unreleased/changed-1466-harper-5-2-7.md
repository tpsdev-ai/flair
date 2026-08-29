- **Harper is now 5.2.7.** Flair pinned `harper@5.2.0`; latest stable is
  5.2.7 (GitHub 2026-08-28). Exact-pin bump within 5.2 — dependency + lockfile
  only. 5.2.6 stops worker respawn from resurrecting the pool mid-shutdown,
  runs `tini -g` as PID 1 in the container image, and preserves failure exit
  codes on shutdown (HarperFast/harper#2316). 5.2.7 adds durable `@computed` /
  `@relationship` integrity (HarperFast/harper#2368). Harper-related work stays
  on latest stable so Flair is not working around something already shipped.

  Downgrade from a 5.2.7-written store to 5.2.0 is forward-only: 5.2.0 cannot
  open the LZ4-compressed RocksDB (`LZ4 not supported in this build`). Restore
  the pre-upgrade snapshot. Same recovery as the 5.1 → 5.2 break.
