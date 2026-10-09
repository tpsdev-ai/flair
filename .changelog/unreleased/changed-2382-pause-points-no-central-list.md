- **Test pause points no longer share a union list.** This removes conflicts on that list. A unit test checks direct literal calls
  and `deleteOwnedRow`'s `point` properties for malformed or duplicate names and rejects unresolved arguments.
  Valid names keep their pause behaviour; malformed names throw `InvalidPausePointError` before the fault-injection gate.
