- **`@harperfast/rocksdb-js` pinned forward to `^2.6.1`, fixing a silent storage read bug without
  taking the rest of the Harper 5.2 bump.** In the affected versions `TransactionHandle::get`
  honoured the caller's column-family override on its synchronous block-cache attempt but dropped it
  in the async worker. Since every table in a database shares one read transaction, each table after
  the first in a request was read through a foreign column family: cache hits correct, **cache misses
  silently returning not-found**. Worst immediately after a restart, and healing as traffic warms the
  cache — so it presents as intermittent missing data rather than an error.

  harper 5.1.22 declares `^2.3.0`, so 2.6.1 satisfies the range and no Harper change is required.

  **Taken separately from #1045 deliberately.** That PR pins harper 5.2.0, which is what turns the
  Mixed-Version Federation lane red — verified as green on other PRs and absent from main, so the
  failure is caused by the pin rather than inherited. 5.2.0 also carries genuinely wanted things (the
  ops-API secrets operations that would remove a manual step from `flair mcp enable`), but those are
  workflow value and this is correctness value. Correctness first; the full bump waits on
  HarperFast/harper#2061 and #2062.

  Verified against real storage rather than mocks: 438 integration tests pass with the new engine.
