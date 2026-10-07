- **`flair init` verifies a supplied admin credential against the running instance before it replaces `~/.flair/admin-pass` (Closes #2271).**

  `flair init` re-persisted the credential from `--admin-pass`, `--admin-pass-file`,
  `FLAIR_ADMIN_PASS` or `HDB_ADMIN_PASSWORD` without checking it against the
  instance already serving, so a wrong value overwrote a working pass file and
  every later admin call failed authentication. The credential is now proven
  with the same admin-gated `GET /HealthDetail` probe the CLI uses elsewhere; a
  value that does not authenticate is refused (non-zero exit, the stored file
  left byte-identical) and the remedy names `flair init --reset-admin-pass` as
  the explicit recovery path. With no instance running (a fresh install) nothing
  is proven and the credential is written as before.
