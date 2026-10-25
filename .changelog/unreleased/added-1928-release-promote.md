- **A privileged `release-promote` workflow runs the canary and promotes the certified package set.**
  The poll's automatic dispatch on the version's tag ref requires a valid marker,
  public tarballs for every lockstep package matching the certified package-set
  digest, and no visible non-dry-run attempt for the version.
  The poll checks both pinned tag rulesets are active, target tags, have no exclusions
  and carry the expected rule types and patterns, and requires
  `current_user_can_bypass=never` for its own token on the immutable ruleset.
  Other actors' rule exceptions are not visible to the poll.
  It also checks the `release-promote` environment has a `v*`-only tag policy.
  On the normal staged-release path, npm approval is the human action when no
  environment reviewers are configured; the poll does not check an approval record.
  The poll ignores dry runs and does not redispatch a visible non-dry-run attempt.
  It dispatches each version at most once per poll; a failed attempt logs that a
  human must inspect it before retrying. If a settings check fails, the poll
  dispatches nothing and fails when a ready version reaches the dispatch. GitHub runs the tag's copy of the
  workflow files, so those settings are the boundary. The workflow's
  own checks (executed files equal to the default branch's, repository scripts only
  from a pinned default-branch commit) are defence in depth. A version older than a
  package's `latest` at the block's pre-move read is refused before any tag moves.

  > **Heads-up:** a repository admin creates the `release-promote` environment once: a
  > deployment policy of exactly the tag pattern `v*` and an `NPM_TOKEN` with write
  > access to the lockstep packages (required reviewers are optional). Before adding the token,
  > audit the creation actors and other actors' rule exceptions. Until the environment exists,
  > the poll dispatches nothing. A manual dispatch with `dry_run` at its default validates
  > through block generation without testing the move or suppressing automatic promotion.
