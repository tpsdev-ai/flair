- **Memory id handling around `.content` and `supersedes` is tightened in the REST middleware, the write paths, the federation merge and the embedding-stamp migration.**
  A Memory request whose last path segment ends in a literal `.content` and is
  not valid percent-encoding gets the named 400 (`memory_id_content_suffix`)
  instead of a 500, whatever its credential: the middleware refuses it before
  any auth branch, so a signed agent, a Basic admin and an anonymous request
  get the same 400. A signed non-admin agent's `GET`/`HEAD` whose id segment
  carries a `/` encoded once or twice (`%2F`, `%252F`) before a
  declared-attribute selector gets the named 400 (`ambiguous_memory_id`). On a
  write through `Memory.post` or `Memory.put`, a `supersedes` reference is
  resolved once (decoded, a trailing declared-attribute selector dropped), and
  that id is the one checked, stored and closed. On those two paths, a write
  whose `supersedes` target read fails is refused
  (`supersedes_target_unreadable`): the predecessor read that every such write
  makes, and, for a non-admin agent, the authorization read (an admin or
  internal write is not read for authorization). For a non-admin agent, a
  target that does not exist is refused as well (`supersedes_target_missing`,
  409) unless the reference is unchanged from the stored row's. A write refused
  for its `supersedes` target changes no row, including its `derivedFrom`
  sources: their `lastReflected` is stamped only after the new row is written.
  For ordinary Memory writes, a change visible at the close's committed re-read
  aborts its transaction; the close retries with the owner comparison (at most
  three attempts). A federated Memory row whose id ends in `.content` is skipped
  (`content_suffix_id_not_federated`), so such a legacy row is not federated.
  The embedding-stamp migration re-embeds a stale row whose id ends in
  `.content` from the text Memory embeds for it (a skill row's `trigger`, else
  its `content`), only when the embedding provider returns a usable vector.
  A change visible at its committed re-read aborts the migration transaction.
  For both paths, a change after that re-read and before commit is settled by
  Harper's timestamp order (see the PR body's residual-gap note).
