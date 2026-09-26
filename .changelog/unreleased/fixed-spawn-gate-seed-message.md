- **The spawn-budget gate's SEED output states exactly what the seed predicate guarantees (flair#1825).**

  On a descendant base it printed that the base "resolves to" the seed-introduction
  commit and that "any other base without the file is refused" — both false for a
  base that DESCENDS from the anchor (the predicate is `isAncestor`, not equality).
  It now names the ACTUAL base sha, says the base DESCENDS from the anchor, and
  says only a base that does not descend from it (or cannot be read) is refused.
  (`test/unit/check-cli-spawn-budgets-gate-1825.test.ts`, round 10.)

  (Refs #1825)
