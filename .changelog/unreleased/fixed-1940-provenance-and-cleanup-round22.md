- **Reindex, feed updates and federation retain memory provenance, while failed pointer cleanup keeps surviving memories in lexical recall.**
  Reindex restores stored provenance byte-for-byte, retains declared and named allowed fields, strips other undeclared fields and generates an absent incarnation token. Feed updates restore stored provenance; new or unstamped feed rows receive a trusted server stamp. Federation sends every field the inbound whitelist retains, including `meta`, `kind` and the named federation bookkeeping fields, and restores the provenance selected by the merge.

  Memory delete notifies the lexical index after its owned Memory-and-pointer transaction commits. A request-owned delete reaches the lexical index through the committed change feed. A failing pointer delete no longer removes the surviving row from a warmed BM25 index. Non-admin Memory search streams its pointer join in bounded chunks, and the orphan sweep counts row read or delete failures, continues with later rows and reports an incomplete run.

  (Refs #1940)
