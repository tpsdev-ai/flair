- **Concurrent first-boot `GET /FederationInstance` requests in one process create exactly one identity row, and every caller is answered with it.**

  The read-mint-write runs in an in-process lock, and the write completes in its
  own transaction before the next caller reads — so a second caller waits,
  re-reads, and is answered the row the first created. The lock serialises GETs in
  this process; an independent writer (`flair init --remote`) is not covered —
  that is slice 2.

  (Refs #1897)
