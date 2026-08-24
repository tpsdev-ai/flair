- **The impl-term-leak gate no longer treats English `ops-*` compounds as bead IDs**
  (flair#1381). `ops-port`, `ops-api`, `ops-target`, and `ops-server` are an
  exact-literal allowlist — not a heuristic. A real bead ID (`ops-xllz`) still
  fails. Each finding now names the matched token and the rule that tripped,
  e.g. `docs/integrations.md:41: matched bead-ID pattern on token "ops-xllz"`.
