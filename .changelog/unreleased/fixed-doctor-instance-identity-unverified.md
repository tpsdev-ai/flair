- **`flair doctor` says UNVERIFIED when it could not run the pairing-role check, and its prune remedy names the form that deletes.**

  `flair doctor` reads the instance's identity rows and its role list as two
  separate reads, and it only printed a green line when the rows came back — even
  when `list_roles` had failed, so the pairing-role half of the check never ran
  and its silence read as a pass. A consistent instance still prints one green
  line naming its identity; when the role list is unreadable the same line is now
  printed as UNVERIFIED, saying which check did not run and why.

  The remedy for several `Instance` rows was `flair federation instance prune
  --keep <id>` — and `prune` is a dry run until `--apply` is passed, so the
  printed command deleted nothing while reading as the fix. The remedy now names
  both forms. When several rows and the pairing role are both present, the two
  remedies are printed in the order they work: the prune first, then
  `flair init --remote`, which refuses while the table still holds more than one
  row.

  (Refs #1883)
