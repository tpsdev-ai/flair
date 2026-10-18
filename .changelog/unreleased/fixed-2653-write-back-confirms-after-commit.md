- **The shared write-back helper confirms its write after the transaction commits.**

  A write that a newer commit dropped is retried from a fresh read, then refused
  by name; it is no longer reported as applied (#2653).
