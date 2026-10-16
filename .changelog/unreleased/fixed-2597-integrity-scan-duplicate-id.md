- **The integrity scan reads Memory and its watermark-bounded deletion history by keyset on
  `id`.** A duplicate id across pages, or a read whose size differs from the exact count of the
  same range, is retried within an attempt bound; if every attempt stays inconsistent the scan
  reports UNKNOWN without advancing the checkpoint, and a retry that reads consistently returns a
  normal verdict. Any other read failure reports UNKNOWN at once. A balanced concurrent write (an
  insert behind the cursor plus a delete of an already-read row) can keep the counts equal, so
  this read is not a snapshot.
