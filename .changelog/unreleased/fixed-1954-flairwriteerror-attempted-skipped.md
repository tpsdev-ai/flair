- **`FlairWriteError` now counts attempted records (skipping text-less ones) and reports skipped counts, and its `status_code` is an `int` or `None`.**
  `add_memory` sets `total` to the records it ATTEMPTED, so text-less entries are
  excluded from `total` and reported in a new `skipped` count (named in the
  message, e.g. "1 of 2 memories written; 1 refused (status 403); 1 skipped (no
  text)"). `FlairWriteError.status_code` is now an `int`, or `None` when the
  failure carried no status (a connection error or timeout) — the `"?"` sentinel
  appears only in the message and the `failed` list, so `status_code >= 500`
  cannot raise a TypeError on a transport failure. The `store_memory` tool keeps
  its `{"error", "written", "failed"}` shape and adds `"skipped"` only when it is
  non-zero.

  (Closes #1954)
