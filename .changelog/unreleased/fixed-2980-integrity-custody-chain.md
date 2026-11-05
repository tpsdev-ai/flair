- **Integrity custody checks directory and staged file identities around commit and tombstone publication.**

  The open handle records directory devices and inodes with `lstat`.
  Commit and tombstone recheck the chain, then verify staged file identities,
  immediately before and after publication rename. Detected drift before rename
  refuses `custody_invalid`;
  detected drift after rename reports `status: "commit_uncertain"`.
  For commits, restore valid custody, re-open it and verify the generation.
  For tombstones, re-open custody to reconcile uncertainty
  and verify the generation if an active enrollment remains.
  When the last enrollment was tombstoned, re-open refusal is expected;
  callers read registry.json, verify its HMAC with verifyIntegrityRecord and custody.key,
  and check sequence against expectedSequence + 1 and the enrollment's status against tombstoned.
  Custody paths are absolute.
  Generation exhaustion reports `status: "commit_failed"` (its
  reason remains `commit_conflict`); callers of commit and tombstone refusals
  decide whether to retry on the status, never on the reason.
  Initialization holds name the registry path to inspect and direct callers to
  preserve partial custody and use a different custodyDir for a fresh start.
  Unrecognised commit and tombstone holds direct callers to inspect the destination and restore valid custody before retrying;
  observation changes report that the destination changed between observations.
  Missing markers during post-publication marker cleanup for commits or tombstones report `status: "commit_uncertain"`.
  Before publication, cleanup errors are not reported and the write returns `status: "commit_failed"`.
  Tombstone cleanup warnings report `status: "commit_uncertain"` with the tombstone remedy.
  Custody-chain and staged-file identity checks compare device and inode values as bigint.
  Generation refusals after publication report `committed: true` and the published generation.
