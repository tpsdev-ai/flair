- **A `<path>.bak` planted as a symlink is now replaced, not written through.**

  The backup writes a temp and renames it over `<path>.bak`, so a `<path>.bak`
  that is a symlink to another file is replaced by a regular 0600 file holding
  the backup bytes — the bare `writeFileSync` it replaced wrote THROUGH the link
  and clobbered the victim. After a run `lstat(.bak)` is a regular file and the
  victim is untouched.

  (Refs #1778)
