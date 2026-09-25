- **A release PR that merges green on main now tags itself.** Tagging used to end
  with a hand-pushed `vX.Y.Z`; that step is automatic now, so `release-publish`
  stages the tarballs (publishing still waits on the maintainer's npm 2FA
  approval) without anyone remembering to push a tag. The tag is written with a
  GitHub App token, because a tag pushed with `GITHUB_TOKEN` would not start
  `release-publish` at all.

  > **Heads-up:** a repo admin installs the GitHub App and splits the release-tag
  > rulesets after this merges. Until then a release refuses loudly with
  > condition `app-not-configured` and opens an issue instead of tagging.
