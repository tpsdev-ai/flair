- **A first-time federation pair confirms its Peer row is still absent before it commits (flair#2512).**

  The first-pair write stages its Peer row with the pairing-token consume in one
  owned transaction, then re-reads the committed Peer row. If that confirm read
  finds a row for the instance, the pairing is refused 409 `peer_row_appeared`:
  the request writes no Peer row, the committed row and its key are left
  unchanged, and the pairing token stays unconsumed. A row committed after the
  confirm read and before the commit is not seen by it.
