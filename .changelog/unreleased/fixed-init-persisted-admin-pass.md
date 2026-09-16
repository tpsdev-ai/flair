- **`flair init` no longer writes a fresh admin-pass file that 401s against a persisted Harper user.**

  When `~/.flair/admin-pass` is missing but the data dir already has an
  admin user, bare `init` refuses and names the two exits: pass the original
  with `--admin-pass-file <path>`, or rotate on purpose with
  `flair init --reset-admin-pass` (the operations socket `alter_user`, then write the
  file). A leftover Harper answering on the port against a fresh data dir
  is refused with `flair stop`. `flair doctor` reports the missing-file
  desync the same way.

  > **Heads-up:** `HDB_ADMIN_PASSWORD` still only seeds a brand-new install.
  > Re-init never rotates a stored hash unless you pass `--reset-admin-pass`.
  > That flag prints the user, socket, and destination file first, and refuses
  > if the operations socket is not owner-only (0700 dir / 0600 socket).
