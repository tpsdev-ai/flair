- **Options a parent command owns now work on its subcommands as documented.**
  Where a subcommand redeclared an option its parent already had — `--target`,
  `--port` and `--admin-pass-file` on `flair federation sync enable|status` —
  the duplicate never received a value; it only made the flag look local. The
  duplicates are gone, the flags still work on those subcommands, and
  subcommand `--help` now lists inherited flags under a **Global Options**
  heading so nothing became less discoverable.

  A test walks the whole command tree and fails on any subcommand that
  redeclares an option name an ancestor already owns, so this class of silent
  drop cannot return the next time a subcommand grows a flag.
