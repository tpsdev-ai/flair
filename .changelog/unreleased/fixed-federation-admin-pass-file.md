- **`flair federation token` and `pair` read the admin password from an owner-only file, keeping it out of shell history and `ps`.**

  Both commands now take `--admin-pass-file <path>`, read in-process through the
  same reader `flair backup` uses: the file must be owner-only (mode 0600), and a
  group- or world-readable file is refused with a message naming the path and the
  mode. Precedence is `--admin-pass-file` > `FLAIR_ADMIN_PASS` > `--admin-pass`;
  combining the file and the flag is a usage error. `--admin-pass` still works,
  but the `--help` text warns that it lands in shell history and the process
  list. The federation docs now show the file form in every token-minting and
  pairing snippet.

  (Refs #1873)