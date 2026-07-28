- **Guide: embedding Flair inside an application that already runs on Harper.**
  [`docs/embedding-in-a-harper-app.md`](docs/embedding-in-a-harper-app.md) covers
  running Flair as a component alongside your own, and reaching its resources
  in-process — no HTTP, no second process, and no shell on the node. Includes
  serving many agents from one process and registering them programmatically,
  both without the CLI.

  The load-bearing detail it documents: `databases.flair.Memory` is the **table**,
  while the exported `Memory` class is the **resource**, and only the resource
  enforces authentication, read-scoping, visibility and embedding. It also spells
  out that a resource instantiated with no context resolves to a trusted
  `internal` call and runs unfiltered — correct for Flair's own maintenance
  passes, a silent trap for an embedding application.
