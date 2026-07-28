- **Fixed: the Harper-embedding guide's first code sample did not run.** `docs/embedding-in-a-harper-app.md`
  told readers to build a resource with `new (flair("Memory"))(undefined, ctx)` and then set
  `h.isCollection = true`. On Harper 5.1.22 that property is a getter with no setter, so the assignment
  raises `TypeError` under ESM strict mode, and omitting it yields `405 … does not have a post method
  implemented`. The Quickstart now uses the shipped `collectionResource()` / `agentContext()` helpers, and
  registration goes through the `Agent` resource rather than a hand-copied raw-table literal.

  Every claim in that guide has now been run end to end against a real Harper with Flair loaded as a
  **second component**, and the "confirm this yourself before building on it" disclaimer is replaced by
  the measurements. Two of them were wrong: `getMatch("/Memory")` misses (the slashless form hits), and
  the registry entry is an object wrapping the class, so `.Resource` is required. Per-agent scoping is
  confirmed through `SemanticSearch` — not just table search — with real embeddings attached, and the
  context-less superuser warning is confirmed on both read paths.

  The guide also now states the thing an integrator most needs: **the context object is a security
  boundary.** In-process identity is asserted, not verified, so it must be built from the app's own
  server-side state and never from request data — with the cluster consequences spelled out.
