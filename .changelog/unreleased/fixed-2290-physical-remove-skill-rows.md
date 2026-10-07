- **`flair agent remove` and `flair memory hygiene --apply` physically remove skill-tagged Memory rows, every version row included (Closes #2290).**

  Both commands remove their targeted rows through one server path, `POST /MemoryPurge`,
  which accepts Basic admin credentials and refuses agent keys, admin agent keys included.
  It deletes each named row and, for a skill-tagged row, every row in that skill's lineage,
  so a superseded version row is removed with its live head. Each row's delete, its
  pointer-row delete and its deletion-history record share one transaction, and a failed
  pointer delete or history write aborts it. After the commit the path reads each row again,
  and a row still stored fails the command. Either command fails when the response does not
  list every requested id as removed, and `agent remove` stops before deleting anything when
  its Memory scan fails or returns an unexpected response. The user-facing
  `DELETE /Memory/<id>` route is unchanged: a skill-tagged row deleted through it is still
  versioned, its head closed rather than removed.
