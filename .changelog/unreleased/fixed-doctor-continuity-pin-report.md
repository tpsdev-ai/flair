- **Doctor names continuity hook pins that are not resolved versions.**
  When both hooks are present, range, tag, unsupported, and malformed specs make the pair stale and appear with their pin classification.
  A lone hook stays partial and reports both the missing entry and any pin problem.
  Doctor and hook status direct non-version pins to manual resolution; doctor does not offer or attempt their rewrite.
  A continuity command without a package retains the stale-form diagnosis.

  (Closes #1819)
