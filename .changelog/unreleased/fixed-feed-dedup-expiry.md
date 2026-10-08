- **A stored ephemeral feed row with no expiry gets its tier expiry when a feed write deduplicates onto it.**
  The feed stamps it through the shared tier rule and responds with the confirmed read-back
  row with legacy inline pointer fields removed. A matched row whose id the feed does not write is refused,
  and one that changes during the request can be answered with
  `409 feed_dedup_target_changed` instead (flair#2358).
