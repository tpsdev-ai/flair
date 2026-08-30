- **Memory bootstrap now honors the `archived` flag.** A memory sent to the
  basement (`archived: true`) is no longer force-injected into bootstrap recall
  — previously the three bootstrap query paths (permanent, recent, and the
  task-relevant candidate pool) omitted the `archived` predicate, so a retired
  `durability: permanent` memory reappeared in every session's bootstrap even
  though it was already excluded from search and attention. No schema change;
  the fix matches the exact condition shape the other four read paths already
  use.
