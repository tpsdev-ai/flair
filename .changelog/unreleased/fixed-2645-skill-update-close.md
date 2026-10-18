- **A skill update confirms the predecessor close before answering success.**

  A newer write to the same skill row could make Harper skip the queued close
  while the successor and version committed, leaving two live heads after a
  200. The close is now confirmed in a fresh committed read, re-applied from
  that read with the row identity and caller authority re-checked, and refused
  with 409 `skill_update_not_closed` (or a named 500 when the successor cannot
  be rolled back) when it still does not land (#2645).
