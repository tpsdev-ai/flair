- **`POST /OrgEvent` checks ownership at lookup and avoids deterministic same-millisecond collisions (random UUID) (#2333).**

  A non-admin POST is refused (403) for a row observed at the guard's lookup as
  owned by another agent. The read-then-write check is not atomic. Creation,
  re-posting the caller's own id, and admin/internal callers are unchanged.
  Default ids now include a random UUID.
