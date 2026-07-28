- **A data directory, home directory or Flair URL containing `&`, `<`, `>`,
  `"` or `'` no longer produces a broken launchd service.** A launchd plist is
  XML, and both plist writers were interpolating values into one unescaped:
  `flair init` wrote the data directory, the install paths and the admin
  credentials raw, and `flair rem nightly enable` did the same for the home
  directory, the shim path and `--flair-url` (a URL with more than one query
  parameter contains `&`). Any of those characters made the plist malformed,
  and `launchctl` rejects a malformed plist outright — so the service or timer
  silently never registered and did not survive a reboot.

  All five XML predefined entities are now escaped through a single shared
  helper, and the generated plists are verified by actually parsing them.
  Nothing to do: re-run `flair init` (or `flair rem nightly enable`) to rewrite
  the plist for an affected install.
