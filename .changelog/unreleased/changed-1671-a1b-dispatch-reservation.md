- **Release staging is dispatched on the tag, reserves each version once, and refuses stale release machinery.**

  `release: vX.Y.Z` is now the only version source: `workflow_dispatch` takes no
  inputs and the run must be on the `refs/tags/vX.Y.Z` ref (a dispatch on `main`
  fails before anything is packed). Immediately before the first stage request,
  `stage-publish` writes a durable `release-attempt` deployment marker for the
  version and refuses if one already exists — so a version that entered staging
  is burned and the next patch is the only path — while `pack` performs the same
  check read-only as an early fail-fast. The stage job also refuses to run unless
  its own workflow file is byte-identical to `origin/main`'s, as defence in depth
  against a tag that points at stale release machinery; the marker itself can be
  deactivated and deleted by the same token, so the burn is enforced by the stage
  job's allowlist and branch protection, not by GitHub.

  (Refs #1671)
