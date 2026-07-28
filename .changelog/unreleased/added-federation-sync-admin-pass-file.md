- **`flair federation sync --admin-pass-file <path>`.** Reads the admin password from a file
  instead of an inline flag, matching `flair backup`, so an unattended sync keeps the secret out of
  `ps` and shell history. The file must be owner-only (`chmod 600`) or the CLI refuses it.
