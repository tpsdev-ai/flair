- **`flair federation sync` now says when the quiet path is private rows
  being withheld, not "no changes"** (flair#1232). Private Memory still
  never leaves the instance. When the spoke found rows since the cursor
  and the push filter held every one back, the printed line is `No
  federable changes since last sync (N rows held back: private
  visibility)` — count and reason only, no content. A genuine empty run
  (nothing since the cursor, nothing withheld) still prints `No changes
  since last sync.` Pairing, hub merge, lastSyncAt advance, and the
  liveness ping are unchanged.
