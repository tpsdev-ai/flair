- **Transactional skill versions for Memory and FeedMemories.**

  Updates require one live head and reject stale targets. PUT/feed archive
  transitions are refused. Cross-owner agent writes require a write grant;
  successors retain the subject owner.

  Unreserved skill deletes close the retained payload and append a tombstone.
  Reserved seed writes and unchanged-payload embedding regeneration keep their
  physical IDs. Reserved-seed deletes, `_reindex`, and the administrator
  operations API do not append skill versions.
