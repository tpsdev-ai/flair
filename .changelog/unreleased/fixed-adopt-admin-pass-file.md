- **Flair now keeps the admin password out of the launchd service file; `flair init` and `flair doctor --fix` refuse to write an unstartable one.**

  `flair init` used to rewrite an already-adopted service into the old shape
  that embedded the admin password in the service file itself — putting the
  secret in a config file and undoing the safe launcher form. Init now always
  writes the launcher form (the password stays in `~/.flair/admin-pass`, 0600),
  and running it against an already-adopted service leaves that file unchanged.

  Both commands use the same rule: reuse an existing valid password file, or
  check a supplied credential against the running instance and only then write
  the file, or refuse with the exact command to fix it and write no service
  file. Adoption also proves the launchd job — not the old process still
  answering the port — serves the instance before reporting success, and a
  service file that still carries the password inline is reported as a failure.
  (Refs #1685 #1693 #1684 #1573)
