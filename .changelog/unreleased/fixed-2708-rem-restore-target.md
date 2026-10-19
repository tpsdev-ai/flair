- **`flair rem restore` lists candidates on the instance it writes to.** The
  operations API is resolved from the same target as the writes — `FLAIR_URL`
  when set, else the local instance — and a port pair that conflicts with the
  configured pair is refused before any delete or write.
