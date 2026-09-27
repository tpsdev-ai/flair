- **The listed CLI admin commands share password-source validation and reject conflicting file and inline credentials.**

  `backup`, `federation sync`/`verify`/`instance`, `memory add`,
  `rem restore --apply`, `soul set`/`get`/`list`, and `agent add` resolve
  `--admin-pass-file` and `--admin-pass` through `resolveAdminPassFromSources`,
  as do `federation token` and `federation pair`. For these commands, supplying
  nonempty values for both options is a usage error and exits before any request.
  Environment-password and local-file fallbacks are command-specific.

  Missing or empty password files are refused with their path; files with
  group or other permission bits are refused with their path and mode.

  > **Heads-up:** For the commands listed above, pass one explicit password
  > source; prefer `--admin-pass-file` to `--admin-pass`.

  (Refs #1910)
