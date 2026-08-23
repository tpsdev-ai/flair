- **LongMemEval bench: retrieved memories now reach the reader WITH their
  dates (`v2-dated` payload), and the per-eval record carries `rankedIds` +
  `retrievalMs`.** The retrieval arms fed the reader bare `- content` lines
  while the full-context arm always saw `[Session X — date]` headers — the
  2026-08 headline-run journal analysis put temporal-reasoning at 37% with 33
  wrong answers where both retrieval tells looked healthy: the reader had the
  right memories but no dates to reason over. Each retrieved memory line is now
  prefixed with its `createdAt` date (`- [YYYY-MM-DD] content`). This is a
  measurement variant: the payload format is version-stamped
  (`readerPayloadFormat: "v2-dated"`) inside the hashed config manifest, so
  dated runs can never hash identically to undated ones. Per-question results
  additionally record the retrieved ids in final rank order and the retrieval
  wall-clock separate from reader latency, closing the journal blind spots
  where a wrong answer could not be attributed retrieval-vs-reader after the
  fact. Bench harness only — shipped Flair behavior is unchanged.
