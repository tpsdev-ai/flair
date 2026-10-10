- **A `PATCH /Memory/<id>` that stores an embedding stamp now trips the embedding-space latch (#2425).**
  Such a PATCH previously stored a caller-supplied `embedding`/`embeddingModel`
  without going through the write-maintained latch that `POST`/`PUT` consult, so a
  row could carry a model stamp the latch never recorded. The PATCH write now calls
  the same latch as `POST`/`PUT`, and the recall and dedup legs refuse a
  mixed-space cosine as before. A PATCH whose body carries no embedding field is
  unchanged.
