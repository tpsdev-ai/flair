- **PATCH updates existing rows; a row is created with POST or PUT.**
  On every table, a PATCH whose target row does not exist is refused with 404
  unless the caller is an administrator or a trusted internal call, and nothing
  is written. Creating a row goes through POST or PUT, which apply the
  resource's own create rules: for example, a Memory PUT takes its owner from
  the authenticated agent and applies the visibility default. A PATCH to an
  existing row, and an administrator's PATCH, are unchanged. The rule is
  applied to every table in the flair database when the component loads, so a
  table added to the schema is covered without being named.

  > **Heads-up:** a client that created rows with PATCH using an agent key now
  > gets 404. Create the row with POST or PUT first; PATCH then updates it.
