- **`flair federation prune --apply` now deletes the Peer row.**
  It previously sent the delete to the admin view's GET-only route, so no peer
  was removed. Each delete now targets the admin-only `/Peer/{id}` resource and
  is confirmed by reading the row back: absent is deleted, present is an error.
  A refused DELETE is an error; a failed read-back is an unknown outcome.
