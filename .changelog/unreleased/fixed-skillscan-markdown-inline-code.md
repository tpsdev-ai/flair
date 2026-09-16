- **SkillScan no longer treats markdown inline code as shell injection.**

  Registering a SKILL.md that names commands in backticks (the published
  `@harperfast/skills` `harper-best-practices` skill) scans clean. A
  genuine command substitution on an executable surface still scores high.

  > **Heads-up:** `tps skill register` still refuses `high`/`critical` with
  > no bypass. The verdict does not yet gate skill *loading* (that is a
  > later #1434 step).
