- **`flair federation prune --apply` deletes the Peer row and confirms it is gone.**
  It previously sent the delete to the admin view's GET-only route, so no peer
  was removed. Each delete now targets the admin-only `/Peer/{id}` resource and
  is followed by a read-back: a peer is reported deleted after a successful
  DELETE only when the read-back shows the row absent. A refused DELETE is an
  error; a read-back that fails is an unknown outcome.
