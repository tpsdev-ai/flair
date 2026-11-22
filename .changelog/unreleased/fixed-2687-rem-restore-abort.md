- **`flair rem restore --apply` stops before deleting or writing any row when it
  cannot list the agent's current memory candidates.** The run reports
  `fetch-candidates: <error>` under `Errors:`, its status is `failed`, and the
  command exits 1, leaving the agent's memories, souls and candidates as they
  were (#2687).
