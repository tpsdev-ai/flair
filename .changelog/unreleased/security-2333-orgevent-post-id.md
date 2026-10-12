- **`POST /OrgEvent` refuses a non-admin post naming an id another agent owns, and default ids are collision-resistant (#2333).**

  The ownership check runs at lookup and is not atomic with the write. Creation,
  re-posting the caller's own id, and admin/internal callers are unchanged when
  the lookup succeeds; a non-admin post whose ownership lookup fails is refused
  and writes nothing.
