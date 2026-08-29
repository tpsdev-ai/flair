- **Harper is now 5.2.7.** Flair pinned `harper@5.2.0`; latest stable is
  5.2.7 (GitHub 2026-08-28). Exact-pin bump within 5.2 — dependency + lockfile
  only. 5.2.6 stops worker respawn from resurrecting the pool mid-shutdown,
  runs `tini -g` as PID 1 in the container image, and preserves failure exit
  codes on shutdown (HarperFast/harper#2316). 5.2.7 adds durable `@computed` /
  `@relationship` integrity (HarperFast/harper#2368). Harper-related work stays
  on latest stable so Flair is not working around something already shipped.
