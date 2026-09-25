- **A hub's federation identity is ONE Instance row, and `flair init --remote` reconciles it instead of inserting a second.**

  `GET /FederationInstance` find-or-creates a row (`role: spoke`), and
  `flair init --remote` used to INSERT a hub row of its own under a fresh random
  id — so a hub that had answered a read carried two rows and no canonical
  identity, and every reader that took "the first row of the search" answered
  from whichever row the table yielded first. Init now reads the rows first:

  - no row → create one with `role: "hub"`;
  - exactly one row → set THAT row's role to `hub`, keeping its id and key (the
    identity peers already know);
  - more than one row → refuse, naming every row (id, role, created) and the
    command that resolves it.

  Re-running is a no-op. `flair federation instance list` shows the rows and
  `flair federation instance prune --keep <id>` deletes the rest (dry-run by
  default; `--apply` to act). Both accept `--admin-pass-file`, which reads the
  admin password from an owner-only file so it stays out of `ps` and shell
  history, as well as `--admin-pass` and `FLAIR_ADMIN_PASS`.
  (`test/unit/federation-instance-admin-pass-file.test.ts`)
