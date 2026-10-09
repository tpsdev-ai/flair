- **Memory id handling around `.content` and `supersedes` is tightened in the REST middleware, the write paths, the federation merge and the embedding-stamp migration.**
  Supersede writes validate the resolved predecessor, and federation excludes
  legacy IDs the write API cannot safely address.
  The embedding-stamp migration re-embeds a stale row whose id ends in
  `.content` from the text Memory embeds for it (a skill row's `trigger`, else
  its `content`), only when the embedding provider returns a usable vector.
  A change visible at its committed re-read aborts the migration transaction.
  A change after that re-read and before commit is settled by
  Harper's timestamp order (see the PR body's residual-gap note).
