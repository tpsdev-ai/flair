- **`flair status` escapes stored text before printing it, and reports unknown per-agent counts after an incomplete scan.**

  The human renderers escape control, format, surrogate, unassigned, line- and
  paragraph-separator code points in agent ids, model names, Soul keys,
  federation and OAuth fields and warning messages; JSON output is unchanged. An
  agent row's memory count, hash-fallback count, 24h writes and last write read
  "unknown" when the Memory scan did not complete, and `flair quality` reports
  no citation rate or quiet verdict for those rows.

  `flair init --agent-id` refuses an id equal to the operator identity before it
  writes a key or registers the agent.
