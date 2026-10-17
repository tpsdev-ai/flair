- **Non-admin Memory writes discard caller-supplied vectors and model stamps.** Embedding is
  computed when the resulting write needs one. A vector-only PATCH retains its stored vector;
  an unchanged skill update retains its stored vector. Non-admin writes cannot relabel
  a stored vector. Administrator writes, trusted in-process writes, federation-sync records,
  and `embedding: null` / `[]` handling are unchanged (flair#2573).
