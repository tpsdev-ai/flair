- **The pairing cleanup pauses when the Instance table holds a row it cannot name.**

  The cleanup sweep's own reader skipped an `Instance` entry with no usable id,
  so a table holding a hub row and a malformed row looked like a single hub and
  the sweep ran, dropping bootstrap users and deleting pairing tokens. It now
  reads through the same strict reader `init` and the server use: an entry
  without a usable id makes the read unreadable, and the sweep pauses for that
  tick instead of acting on part of the table.
  (`test/unit/federation-cleanup.test.ts`)
