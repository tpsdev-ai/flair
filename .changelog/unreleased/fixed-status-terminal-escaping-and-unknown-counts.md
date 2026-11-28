- **`flair status` escapes the stored fields it prints, and reports unknown per-agent counts after an incomplete scan.** ([#3101](https://github.com/tpsdev-ai/flair/pull/3101), [#3111](https://github.com/tpsdev-ai/flair/pull/3111))

  `flair status`, `flair status deep`, `flair status federation` and
  `flair status rem` render control characters in stored text visibly. Terminal escaping does not change JSON
  output; a failed Memory scan makes the per-agent `memoryCount`,
  `hashFallback`, `writes24h`, `usageCount` and `lastWriteAt` values null in
  JSON. When a row's memory count is unknown, plain status prints "unknown" for
  memory count and last write, deep status also prints hash-fallback count and
  24h writes as "unknown", and neither table displays `usageCount`;
  `flair quality` reports no citation rate or quiet verdict for those rows.

  `flair init --agent-id` refuses an administrator username
  reserved by this init path — the default administrator name, the cluster administrator
  on the provisioning path, or the administrator name configured for an
  already-running instance — before it writes a key or registers the agent.
