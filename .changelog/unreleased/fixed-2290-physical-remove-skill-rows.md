- **`flair agent remove` and `flair memory hygiene --apply` physically remove skill-tagged Memory rows, every version row included (Closes #2290).**

  Both commands remove their targeted rows through one server path, `POST /MemoryPurge`,
  which accepts Basic admin credentials and refuses agent keys, admin agent keys included.
  It deletes each named row and, for a skill-tagged row, every row in that skill's lineage,
  so a superseded version row is removed with its live head. The row deletes and, for
  permanent or persistent rows, their deletion-history records share one transaction, and a
  failed history write aborts it. After the commit the path reads each row again. A row still
  stored fails the command and keeps its pointer row, and the path deletes any history record
  it wrote for that row. Pointer rows are deleted only for rows the read finds gone. Each of
  these cleanup deletes is checked by a read after its commit, and one that fails or is not
  confirmed fails the command. Either command fails when the response does not list every
  requested id as removed, and `agent remove` stops before deleting anything when its Memory
  scan fails or returns an unexpected response. The user-facing `DELETE /Memory/<id>` route
  is unchanged: a skill-tagged row deleted through it is still versioned, its head closed
  rather than removed.
