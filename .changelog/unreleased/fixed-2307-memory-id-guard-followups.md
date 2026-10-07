- **Memory id guarding is tightened on the write paths, the read middleware, the federation merge and the embedding-stamp migration.**
  A malformed percent-encoding in a URL-bound `.content` id now yields the
  named 400 (`memory_id_content_suffix`) instead of a 500; an encoded `/` is
  refused at more than one encoding depth; a `supersedes` reference is authorized against
  the record it resolves to rather than the literal string; a federated Memory
  row whose id ends in the `.content` property suffix is skipped; and the
  embedding-stamp migration re-embeds a legacy row whose id already ends in
  `.content`, so such a row converges instead of staying pending.
