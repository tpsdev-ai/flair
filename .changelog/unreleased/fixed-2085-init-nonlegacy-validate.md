- **`flair init` validates the launchd plist it writes when there is no legacy job to migrate (Closes #2085).**

  When rollback succeeds after a validation failure — including a lint that
  throws — prior bytes and mode are restored, or a plist init created is
  removed. Existing plist symlinks, including dangling links, are refused
  before writing. A failed restore is reported and init exits 1.
