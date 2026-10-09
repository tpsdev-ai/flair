- **A failed-tool append waits up to 2 seconds for the capture lock.**
  If the lock remains busy, the append refuses; lock contention and pending-write
  errors are reported on stderr (flair#2395).
