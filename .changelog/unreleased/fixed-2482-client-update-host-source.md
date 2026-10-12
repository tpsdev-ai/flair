- **Non-skill `memory.update()` preserves stored host-source pointers on same-ID writes unless the caller supplies a replacement (#2482).**
  The client omits read-projected pointer fields; a `preserveHistory` successor carries a
  pointer only for a host source the caller supplies.
