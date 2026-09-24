- **Capture capacity is one budget: a run holds a slot from admission until its record is removable.**

  The per-run capture state and its retired/aborted tombstones no longer have
  separate caps. A run holds ONE slot in a single budget (default 10,000) from
  admission until its record is removable — retired or aborted, with no write in
  flight, and past `tombstoneMinAgeMs` (1 hour); retiring or aborting a run
  changes its phase IN PLACE, with no new room needed. Admission removes what the
  age rule already allows and admits only below the cap; it NEVER evicts a live
  record (an idle run retires through the idle rule), and when the budget is full
  it refuses (`capture-capacity: full`, logged once) and mutates nothing. An
  abort for a run that was never admitted is always recorded — see the abort
  overflow in the round-5 entry — so a later callback for that failed run cannot
  be admitted.

  (Refs #1751)
