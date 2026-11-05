- **Integrity custody checks directory identities around commit and tombstone publication.**

  The open handle records each path's device and inode with `lstat`, and the
  commit and tombstone paths recheck the chain immediately before and after
  publication rename. Detected drift before rename refuses `custody_invalid`;
  detected drift after rename reports `status: "commit_uncertain"` and requires
  re-opening custody: verify the generation for commits; for tombstones, reconcile
  uncertainty, then verify the authenticated registry sequence and the enrollment's
  tombstone status. A process that can write an ancestor is outside the custody
  trust boundary and can still race the rename. The checks detect drift present
  when they run; they do not guarantee detection of an intervening race. Custody
  paths are absolute.
  Generation exhaustion reports `status: "commit_failed"` (its
  reason remains `commit_conflict`); callers decide whether to retry on the
  status, never on the reason.
  Initialization holds name the registry path to inspect and direct callers to
  preserve partial custody and use a different custodyDir for a fresh start.
  Unrecognised commit and tombstone holds name the destination to inspect before retrying;
  observation changes report that the destination changed between observations.
  Tombstone cleanup warnings require uncertainty reconciliation and verification
  of the authenticated registry sequence and enrollment tombstone status.
