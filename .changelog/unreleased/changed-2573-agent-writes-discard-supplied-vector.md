- **Non-admin Memory writes discard caller-supplied vectors and model stamps that differ from the stored row's.** Embedding is
  computed when the resulting write needs one. Non-admin writes cannot relabel
  a stored vector. Administrator writes, trusted in-process writes, federation-sync records
  are unchanged. Empty-vector normalization and the re-embed request protocol are unchanged;
  an ordinary non-admin write strips a supplied stamp even alongside a null or empty embedding (flair#2573).
