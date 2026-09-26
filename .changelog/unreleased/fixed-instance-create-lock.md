- **Concurrent first-boot `GET /FederationInstance` requests create exactly one identity row, and every caller is answered with it.**

  The read-mint-write runs in an in-process lock and the write commits under it
  (a detached transaction), so a second caller waits, re-reads, and is answered
  the row the first created — instead of each caller minting its own row. The
  lock covers only the create path; a request that finds an existing row is not
  serialised.

  (Refs #1897)
