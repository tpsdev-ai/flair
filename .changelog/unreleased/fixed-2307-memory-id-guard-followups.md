- **Memory id handling around `.content` and `supersedes` is tightened in the REST middleware, the write paths, the federation merge and the embedding-stamp migration.**
  A Memory request whose last path segment ends in a literal `.content` and is
  not valid percent-encoding gets the named 400 (`memory_id_content_suffix`)
  instead of a 500. A non-admin `GET`/`HEAD` whose id segment carries a `/`
  encoded once or twice (`%2F`, `%252F`) before a declared-attribute selector
  gets the named 400 (`ambiguous_memory_id`). A `supersedes` reference is
  resolved once (decoded, a trailing declared-attribute selector dropped), and
  that id is the one checked, stored and closed. A write whose `supersedes`
  target read fails is refused (`supersedes_target_unreadable`): the
  predecessor read that every such write makes, and, for a non-admin agent,
  the authorization read (an admin or internal write is not read for
  authorization). For a non-admin agent, a target that does not exist is
  refused as well (`supersedes_target_missing`, 409) unless the reference is
  unchanged from the stored row's. A write refused for its `supersedes` target
  changes no row, including its `derivedFrom` sources: their `lastReflected`
  is stamped only after the new row is written. The close of a superseded row
  re-reads it and writes in one owned transaction; for a non-admin agent's
  write it also compares, inside that transaction, the row's owner with the
  owner the authorization read saw, and does not close a row whose owner
  differs. A federated Memory row whose id ends in `.content` is skipped
  (`content_suffix_id_not_federated`), so such a legacy row is not federated.
  The embedding-stamp migration re-embeds a stale row whose id ends in
  `.content` from the text Memory embeds for it (a skill row's `trigger`, else
  its `content`), only when the embedding provider returns a usable vector and
  the row is unchanged since it was read; otherwise this migration does not
  stamp the row.
