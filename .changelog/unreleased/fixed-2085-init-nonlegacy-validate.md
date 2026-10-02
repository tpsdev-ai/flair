- **`flair init` validates the launchd plist it writes when there is no legacy job to migrate (Closes #2085).**

  A plist that fails validation — including a lint that throws — has its prior
  bytes and mode restored, or is removed when init created it. Existing plist
  symlinks, including dangling links, are refused before writing. A failed
  restore is reported and init exits 1.
