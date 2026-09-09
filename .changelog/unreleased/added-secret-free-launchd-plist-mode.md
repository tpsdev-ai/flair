- **Add an opt-in secret-free launchd plist mode.** `buildLaunchdPlist` can now
  emit a plist whose `ProgramArguments` point at a product launcher that reads
  the admin password from a 0600 file at start time, instead of embedding
  `HDB_ADMIN_PASSWORD` inline.

  This is the product prerequisite for the `flair doctor --fix` launchd repair
  (flair#1573). The existing inline behavior is unchanged for current `flair
  init` callers.
