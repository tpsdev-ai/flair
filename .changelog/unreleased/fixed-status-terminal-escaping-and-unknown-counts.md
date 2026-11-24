- **`flair status` escapes the stored fields it prints, and reports unknown per-agent counts after an incomplete scan.**

  `flair status` and `flair status deep` escape control, format, surrogate,
  unassigned, line- and paragraph-separator code points in agent ids, model
  names, Soul keys, federation and OAuth fields, warning messages,
  bridge-installed names and disk paths, the BM25 index summary in both views;
  deep also escapes the REM nightly and last-distilled timestamps and bootstrap
  error text. Terminal escaping does not change JSON
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
