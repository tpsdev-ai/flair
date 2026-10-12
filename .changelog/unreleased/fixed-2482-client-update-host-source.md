- **`memory.update()` without a host source leaves the stored pointer byte-identical (#2482).**
  The client no longer echoes the read projection's stripped pointer back as a new claim; a
  `preserveHistory` successor carries a pointer only for a host source the caller supplies.
