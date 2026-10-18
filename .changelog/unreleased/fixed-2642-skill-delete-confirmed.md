- **A skill-tagged Memory DELETE now confirms its version close before answering success.**

  A newer write to the same skill row could make Harper skip the queued close
  while the tombstone committed; the row then stayed open after a 200. The
  close is now confirmed in a fresh committed read, re-applied from that read
  with the row identity and caller authority re-checked, and refused with 409
  `skill_delete_not_closed` when it still does not land (#2642).
