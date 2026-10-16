- **The integrity scan reads Memory and its watermark-bounded deletion history by keyset on
  `id`.** A duplicate id across pages, or a read whose size differs from the exact count of the
  same range, is retried within an attempt bound and then reports UNKNOWN without advancing the
  checkpoint; any other read failure reports UNKNOWN at once. A balanced concurrent write (an
  insert behind the cursor plus a delete of an already-read row) can keep the counts equal, so
  this read is not a snapshot.
