- **The shared write-back helper confirms its write after the transaction commits.**

  A write a newer commit dropped is retried from a fresh read and refused by
  name if no attempt lands; it is not reported as applied (#2653).
