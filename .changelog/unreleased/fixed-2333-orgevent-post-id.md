- **`POST /OrgEvent` refuses an id that already names another agent's event, and its default id no longer collides (#2333).**

  The post path stamped `authorId` from the signature but wrote a caller-supplied
  `id` straight through to the table write, so an agent could POST with another
  agent's existing event id and overwrote that event; the default id also embedded
  the wall clock at millisecond resolution only, so two events posted by one author
  in the same millisecond shared one id and one was lost. Post now applies the same
  owner-field rule `PUT`/`PATCH` apply: a non-admin caller's POST that names an event
  stored and owned by another agent is refused (403), a create and a re-post of the
  caller's own id are unchanged, and the default id carries a random suffix so two
  same-millisecond posts mint different ids.
