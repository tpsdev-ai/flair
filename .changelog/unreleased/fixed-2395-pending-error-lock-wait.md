- **A failed-tool append waits up to 2 seconds for the capture lock.**
  If the lock remains busy, the append refuses. The installed hook suppresses
  stdout, reports lock contention and pending-write errors on stderr, and exits 0
  (flair#2395).
