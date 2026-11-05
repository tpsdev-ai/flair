- **Integrity custody checks directory identities around commit and tombstone publication.**

  The open handle records each path's device and inode with `lstat`, and the
  commit and tombstone paths recheck the chain immediately before and after
  publication rename. Detected drift before rename refuses `custody_invalid`;
  detected drift after rename reports `status: "commit_uncertain"` and requires
  re-opening custody and verifying the generation. A process that can write an
  ancestor is outside the custody trust boundary and can still race the rename;
  the checks detect a change but cannot prevent it. Custody paths are absolute.
  Generation exhaustion reports `status: "commit_failed"` (its
  reason remains `commit_conflict`); callers decide whether to retry on the
  status, never on the reason.
