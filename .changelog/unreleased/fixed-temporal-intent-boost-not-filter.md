- **Recall no longer drops older memories when the query text merely mentions a
  time.** A temporal word in a search query (e.g. an incidental "today" sitting
  inside a slogan) used to derive a hard `since` cutoff that silently excluded
  every memory older than that window — so an on-topic recall could return
  nothing. Text-derived temporal intent now only nudges recency in ranking; it
  never filters. An explicit `since` API parameter still hard-filters, unchanged.
