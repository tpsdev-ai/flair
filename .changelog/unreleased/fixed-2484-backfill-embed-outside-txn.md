- **The embedding backfill computes its vector before its write transaction opens.**

  The backfill a successful `Memory` write runs in the background reads the row
  and computes the vector outside the write transaction; inside the
  transaction it re-confirms the committed row and that the text the vector was
  computed from is unchanged. A text change committed while the vector is being
  computed aborts that attempt and the backfill recomputes, up to a bounded
  number of attempts, so a drifted text is not written against the vector of
  the text it replaced.
