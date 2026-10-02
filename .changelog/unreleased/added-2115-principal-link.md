- **`flair principal link`/`unlink`/`links` map one IdP login to a principal on an already-enabled instance.** The
  mapping write is the same step `flair mcp enable` runs, without the rest of its flow (and without its restart
  prompt). `flair principal link <principal> --idp-subject <login>` refuses a missing principal by name, reports a
  subject already mapped to that principal without writing, and refuses a subject mapped to a different principal
  unless `--replace` moves it, which prints the principal it left and any credential the move superseded.
  `flair principal unlink <principal> --idp-subject <login>` revokes one mapping (the row stays, `revoked`, and stops
  resolving), and `flair principal links <principal>` lists a principal's current mappings.
