- **`flair agent remove` and `flair memory hygiene --apply` physically remove skill-tagged Memory rows, every version row included (Closes #2290).**

  Both commands remove their targeted rows through one server path, `POST /MemoryPurge`,
  whose contract is physical removal. It deletes each named row and, for a skill-tagged row,
  every row in that skill's lineage, so a superseded version row is removed with its live
  head. Each durable row's removal is recorded as deletion history in the same transaction,
  and a failed pointer or history write aborts the transaction. A row counts as removed only
  when its delete is confirmed; a row the path cannot confirm fails the command. The
  user-facing `DELETE /Memory/<id>` route is unchanged: a skill-tagged row deleted through it
  is still versioned, its head closed rather than removed.
