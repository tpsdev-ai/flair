- **Capture capacity is now ONE map: one record per run, one removal rule, no separate tombstone set.**

  Four rounds of fixes kept leaking at the boundary between the live-state map,
  the retired/aborted tombstone set and the budget counters, so round 5 replaces
  all three with ONE `Map<runKey, RunRecord>`. A record's phase is `live`,
  `ended`, `aborted` or `retired`, and the budget IS the map's size; retiring and
  aborting change the phase IN PLACE and never add an entry. A single predicate
  is the only thing that frees a slot — retired or aborted, with no write in
  flight, and aged past `tombstoneMinAgeMs` — and the sweep and admission both
  use it. An abort for a run that was never admitted ALWAYS gets an aborted
  record, even at the cap, using an overflow of at most `abortOverflowCap`
  (1,000): recording nothing there let that failed run's next callback be
  admitted and captured. When even the overflow is full the abort records nothing
  and logs once (`capture-capacity: abort-overflow`) — a documented residual,
  since admission is refused while the budget and its overflow are full.

  (Refs #1751)
