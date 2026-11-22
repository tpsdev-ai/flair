- **`flair help <command> <subcommand>` now prints that subcommand's help.** It
  used to print the parent command's help, so `flair help presence set` showed
  `flair presence`'s flags instead of the `set` flags. An unknown path prints the
  deepest command that matched plus an `unknown command` line and exits non-zero.
