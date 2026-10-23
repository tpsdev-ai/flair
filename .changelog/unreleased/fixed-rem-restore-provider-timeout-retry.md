- **`flair rem restore` retries a memory write refused with `503 memory_provider_timeout` once.** A write refused with any other error or status, or refused with the same timeout again, is recorded as failed as before, and the restore's output names the rows it retried.

  The retry waits a short delay, so a single provider stall no longer fails an otherwise complete restore. The post-restore verification still compares the agent's memory and soul ids with the snapshot's, reporting expected ids that are missing and ids the snapshot does not hold.
