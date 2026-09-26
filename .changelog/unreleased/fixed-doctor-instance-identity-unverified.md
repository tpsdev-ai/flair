- **`flair doctor` says UNVERIFIED when it could not run the pairing-role check, and its prune remedy names the form that deletes.**

  `flair doctor` reads the instance's identity rows and its role list as two
  separate reads. A consistent instance prints one green line naming its
  identity; when the role list is unreadable the pairing-role line prints as
  UNVERIFIED instead, saying which check did not run and why. A check that did
  not run is never silent, and never green.

  An instance with several `Instance` rows AND an unreadable role list prints
  both facts: the row finding with its remedy, and the pairing-role UNVERIFIED
  line naming what could not be read.

  The remedy line names both forms of the command that resolves several
  `Instance` rows — `flair federation instance prune --keep <id>`, and the same
  command with `--apply` — because `prune` is a dry run until `--apply` is
  passed. When several rows and the pairing role are both present, the two
  remedies print in the order they work: the prune first, then
  `flair init --remote`, which refuses while the table still holds more than one
  row.

  (Refs #1883)
