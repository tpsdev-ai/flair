- **The CLI spawn-budget gate builds no regular expression from source text, so a file it scans cannot inject a pattern (flair#1825).**

  The `signal:`-identifier check matched a variable name with a *dynamic*
  `new RegExp(...)` built from that name, escaping only `$`. It now scans with
  fixed literal patterns that capture any identifier and compares the captured
  name with `===` — nothing from the scanned file reaches a regex engine.
  (`test/unit/check-cli-spawn-budgets-gate-1825.test.ts`, round 7 item 3 and
  round 8 item 2.)

  (Refs #1825)
