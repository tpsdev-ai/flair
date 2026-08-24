- **Hybrid recall now orders equal-scoring memories deterministically**
  (flair#1363, found while proving flair#1357 above; Kern-ruled 2026-08-24).
  `buildBM25().rank()` sorted on score alone, and because `Array.prototype.sort`
  is stable, documents with bit-identical BM25 scores came back in whatever
  order the corpus had been fetched in — Harper's, which is a QUERY-PLAN
  artifact rather than a property of the store. Measured on a live instance: the
  same rows, for the same query text, iterate in one order under the multi-agent
  read-scope OR-group (the reader's own `agentId`-indexed rows lead) and in a
  different one under a `tags`/`subject` filter (plain primary-key order), and
  Harper's planner is cost-based so which applies depends on data distribution.
  Ties are common — a memory matching one rare query term once, with the same
  token count as another, scores identically, and the live corpus clusters at
  19-33 tokens — so 96-99% of queries at realistic corpus shapes had a tie
  inside the returned window. Both the scan path and the new index now sort by
  score descending, then ascending `id`. The only results that move are ones
  that had no defined order to begin with; nothing above a tie changes position.
