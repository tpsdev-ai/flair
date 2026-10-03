- **`flair principal link`/`unlink` and the shared provisioner re-validate the mapping immediately before writing, refusing a concurrent change (flair#2222).**

  Harper's operations API exposes no compare-and-set and no cross-request
  transaction on this path, so the strongest bound it admits is used: the
  principal Agent's presence and the subject's Credential rows are re-read
  right before the write, and any difference refuses with
  `mapping-changed-underneath` and writes nothing. The interval between that
  re-read and the write is the remaining window; no atomicity is claimed.
