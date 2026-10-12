- **Ordinary, non-skill, same-ID `memory.update()` calls without a host source preserve the stored pointer (#2482).**
  The client omits read-projected pointer fields; a `preserveHistory` successor carries a
  pointer only for a host source the caller supplies.
