- **Integrity custody checks directory and staged file identities around commit and tombstone publication.**

  The open handle records directory devices and inodes with `lstat`.
  Commit and tombstone recheck the chain, then verify staged file identities,
  immediately before and after publication rename. Detected drift before rename
  refuses `custody_invalid`;
  detected drift after rename reports `status: "commit_uncertain"` and requires
  re-opening custody: verify the generation for commits; for tombstones, reconcile
  uncertainty, then verify the authenticated registry sequence and the enrollment's
  tombstone status. Custody paths are absolute.
  Generation exhaustion reports `status: "commit_failed"` (its
  reason remains `commit_conflict`); callers decide whether to retry on the
  status, never on the reason.
  Initialization holds name the registry path to inspect and direct callers to
  preserve partial custody and use a different custodyDir for a fresh start.
  Unrecognised commit and tombstone holds name the destination to inspect before retrying;
  observation changes report that the destination changed between observations.
  Missing markers during post-publication marker cleanup for commits or tombstones report `status: "commit_uncertain"`.
  Before publication, cleanup errors are not reported and the write returns `status: "commit_failed"`.
  Tombstone cleanup warnings report `status: "commit_uncertain"` and require
  uncertainty reconciliation and verification of the authenticated registry
  sequence and enrollment tombstone status.
