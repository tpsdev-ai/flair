- **`flair quality` no longer pulls the Memory table with embeddings inline
  to sample 10 memories (flair#1360).** The recall spot-check now GETs a
  Harper-projected, recency-sorted, bounded window
  (`select(id,subject,content,createdAt)` + `limit(0, 26)`) instead of an
  unfiltered `GET /Memory?agentId=…` that returned every row's embedding
  vector — 66 MB, twice per `--emit` run on a 3k-row production store, and
  growing with store size. The previous-snapshot lookup uses the same
  projection. Score, sample frame (most-recently-written), and auth path
  are unchanged.
