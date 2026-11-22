- **The feed write path records the id's outcome-unknown marker when storage withholds a write result (flair#2857).**

  The ordinary `POST /FeedMemories` write-back and the dedup expiry repair mark
  the id outcome-unknown when the raw table returns a `Response` instead of the
  row, and answer the `500 write_response_withheld` refusal. A confirmed write
  records no marker.
