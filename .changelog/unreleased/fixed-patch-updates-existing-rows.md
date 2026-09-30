- **PATCH updates existing rows; for a caller that is not an administrator it never creates one.**
  On every table in the flair database, a PATCH from a caller that is not an
  administrator or a trusted internal call writes nothing when its target row
  does not exist. The table's guard answers 404; a resource or authorization
  check that refuses the request first answers with its own status (for
  example, MemoryHostSource and MemoryUsage refuse such a PATCH with 403).
  Where a resource permits creation, create the row with POST or PUT under the
  resource's own create rules; for example, a Memory PUT requires the supplied
  owner to match the authenticated agent. A PATCH to an existing row, and an
  administrator's PATCH, are unchanged. The guard is installed on every table
  class in the database's table registry when the component loads, so a table
  added to the schema gets it without being named. A resource that overrides
  `patch()` keeps it only by ending in `super.patch()` or by refusing creation
  itself, as MemoryHostSource does.

  > **Heads-up:** a client that created rows with PATCH using an agent key now
  > gets a refusal (404, or the resource's own refusal). Where the resource
  > permits creation, create the row with POST or PUT first; PATCH then updates it.
