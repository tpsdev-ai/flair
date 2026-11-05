- **An unconfirmed ordinary feed write or dedup expiry repair records the id's outcome-unknown marker inside its lock (flair#2806, flair#2807).**

  The ordinary `POST /FeedMemories` write-back records the marker before the
  lock is released when its committed-row read-back fails or does not show the
  write — the `409 feed_write_unconfirmed` answer — and the dedup expiry repair
  does the same when its post-commit confirmation read fails or does not show
  its expiry on the matched row. A later owner PUT, PATCH or DELETE of that id,
  and a later feed request that reaches the ordinary write-back for it, answer
  `503 write_outcome_unknown` until the process restarts.
