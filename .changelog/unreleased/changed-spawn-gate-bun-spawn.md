- **The CLI spawn-budget gate now sees `Bun.spawn`/`Bun.spawnSync` and named aliases, so an untimed Bun spawn of the CLI entry fails too.**

  The gate reads `Bun.spawn`'s `(argv, options)` shape as well as node's
  `(cmd, argv, options)`, and matches a literal CLI entry or a file-local
  `join(…, "cli.ts")`. Every offender that cannot be budgeted yet is held in a
  reviewed baseline file (`scripts/ci/cli-spawn-budgets.baseline.json`) keyed on
  file + enclosing helper/case + normalized call fingerprint + kind — never
  `file:line`; one entry covers one call; a stale entry fails the gate, so the
  list can only shrink; and a new offender fails even if a matching entry is
  added in the same change. The ONE exception is the one-time seed: while the base
  has no baseline file but descends from the seed-introduction anchor, the PR's
  copy is the initial list (logged); the next PR that touches the gate removes
  it. The six sites #1825 named now carry a `timeout`; the
  rest are baselined with a reason each.

  (Refs #1825)
