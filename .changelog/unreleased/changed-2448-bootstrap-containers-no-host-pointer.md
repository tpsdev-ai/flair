- **Bootstrap's structured containers and the admin bootstrap carry no host-source pointer (#2448).**

  A `memories` or `predicted` entry omits `hostSource`. A visible, bound
  pointer appears in the bootstrap PROSE only when `includeContext` is true,
  for an authenticated non-admin caller; the admin bootstrap prose is uncited.
  A non-admin structured consumer that needs the pointer reads the memory
  back through the gated Memory read — `memory_get` by id — which renders the
  pointer that caller may see. An admin `memory_get` takes no pointer join, so
  it does not render the pointer either.
