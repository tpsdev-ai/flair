- **The integrity scan tolerates a duplicate id from the operations-API search.**
  The operations API can return the same Memory id twice: a row carries its
  version history, and a write during the read can surface a second version. The
  scan keeps the first sighting and lets the exact-count recheck decide whether
  the read was consistent, instead of reporting UNKNOWN on the duplicate alone. A
  read whose distinct ids miss the count is still refused.
