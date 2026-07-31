- **`flair search --explain` now works when stdout is not a terminal.** Previously
  the flag was accepted and silently did nothing for every script, agent, CI job
  or `| less` — a non-TTY stdout selects JSON output, and the JSON path returned
  before the breakdown was ever rendered. The breakdown now rides along the JSON
  as an `_explain` object on each hit, so non-interactive callers get it too.
  Output without `--explain` is unchanged.

  The breakdown itself is also more truthful: it no longer labels a raw score
  `composite=` under the default `--scoring raw`, and it no longer reports
  `retrievalCount`, which stopped participating in the composite formula when
  usage replaced retrieval as the reinforcement signal. It now reports the
  ranking inputs the server actually returned — raw score, composite score under
  `--scoring composite`, durability, age and usage count.
