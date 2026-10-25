- **A federation retry row reopened after a terminal outcome is stored without its terminal fields and is offered again like any pending row.**
  The sync sender writes `resolution`, `completedAt` and `bound` as null on every write that sets a retry row to pending, and reports a retry-row write as unconfirmed when its read-back is pending but still holds one of those fields (#2874).
