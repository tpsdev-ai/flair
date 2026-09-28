- **`flair upgrade` no longer rolls back when Flair was not running.** A failed
  post-upgrade start rolls the package back only if an instance was up
  beforehand. A previous version npm marks deprecated is never reinstalled. If
  a rollback's own restart fails, the command exits nonzero and names that
  version as known-broken, with a reinstall command instead of `flair start`.

  > **Heads-up:** Upgrading a stopped or never-started install keeps the new
  > version when the post-upgrade start fails. It does not reinstall the
  > previous package.
