- **Fixed: the native `/mcp` write tools threw instead of writing.** `memory_store`,
  `memory_update` (with `preserveHistory`), `flair_workspace_set` and `flair_orgevent` bound their
  delegated resource by assigning `h.isCollection = true`. On Harper 5.1.22 that property is a
  getter with no setter, so under ESM's strict mode the assignment raised
  `TypeError: Cannot set property isCollection … which has only a getter` before the write was
  ever attempted. All four now go through `collectionResource()`. Read-only tools were unaffected.

  The unit doubles carried a writable `isCollection` field, which accepted the assignment and kept
  the suite green; they now reproduce Harper's getter-only accessor and private collection flag, so
  the same mistake fails a test.
