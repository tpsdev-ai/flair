- **Integrity custody refuses a commit or tombstone when the custody directory, an ancestor or the generations directory changed after open.**

  The open handle records each path's device and inode with `lstat`, and the
  commit and tombstone paths recheck the chain before the intent marker or
  evidence write. Generation exhaustion reports `status: "commit_failed"`, not
  `commit_conflict`; callers decide whether to retry on the status, never on the
  reason.
