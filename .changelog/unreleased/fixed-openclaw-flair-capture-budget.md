- **Capture capacity is one budget: a run holds a slot from admission until its tombstone ages out.**

  The per-run capture state and its retired/aborted tombstones no longer have
  separate caps. A run holds ONE slot in a single budget (default 10,000) from
  admission until its tombstone ages past `tombstoneMinAgeMs` (1 hour); retiring
  or aborting an admitted run converts its state into its tombstone IN PLACE,
  with no new room needed. Admission computes feasibility before mutating: a
  free slot exists, or one is made by evicting a tombstone past the minimum age —
  it NEVER evicts a live state (an idle run retires through the idle rule), and
  when no slot is free it refuses (`capture-capacity: full`, logged once) and
  mutates nothing. An abort for a run that was never admitted adds a tombstone
  only if a slot is free.

  (Refs #1751)
