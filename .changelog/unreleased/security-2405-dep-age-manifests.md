- **The bake-time gate classifies dependency ranges and names applied exemptions (flair#2405).**

  The gate reports range declarations as unchecked, rejects unsupported
  specifiers before registry queries, checks aliases by target, and names dated
  exemptions used by a passing run. An unreadable or invalid workspace manifest
  fails the gate.
