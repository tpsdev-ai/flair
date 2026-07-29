- **Flair warns when a resource is called with no caller context.** Constructing
  a resource without a context resolves to Flair's trusted internal verdict and
  runs unfiltered — every read unscoped, every write unattributed — which is
  correct for Flair's own maintenance work and a silent, invisible mistake in an
  embedding application. The verdict is unchanged; it is no longer silent. A
  call that means to take that authority declares it with `internalContext()`
  and stays quiet; anything else logs once per process with the stack.

  The embedding guide's note that reads do not need `collectionResource()` has
  been corrected: reads do not need the collection binding, but they do still
  need the context. A search with the context argument omitted, running outside
  a request scope, returns every agent's private records — and on that path the
  resource's own gate is never consulted.
