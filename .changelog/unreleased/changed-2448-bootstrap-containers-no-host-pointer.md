- **Bootstrap's structured containers and the admin bootstrap carry no host-source pointer (#2448).**

  A `memories` or `predicted` entry omits `hostSource`; for an authenticated
  non-admin caller the pointer renders as the `formatMemory` prose citation
  (also in the `context` mirror when `includeContext: true`). A consumer that
  needs a memory's host source joins the `MemoryHostSource` row by `memoryId`
  explicitly.
