- **`flair keys prune` moves an ownership sidecar only when the sidecar path is a regular file.**
  A directory, symlink, FIFO or socket at that path leaves the key and the path in place,
  with a reason naming the path and its type.
