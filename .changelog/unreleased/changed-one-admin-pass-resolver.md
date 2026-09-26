- **Every CLI command resolves the admin password through one resolver, and a file-plus-flag conflict is now a usage error.**

  `backup`, `federation sync`/`verify`/`instance`, `memory add`,
  `rem restore --apply`, `soul set`/`get`/`list`, and `agent add` now resolve
  `--admin-pass-file` and `--admin-pass` through `resolveAdminPassFromSources`
  — the same resolver `federation token`/`pair` already use. Precedence for the
  common case is unchanged: an explicit option (file or flag) overrides
  `FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD`, and `FLAIR_ADMIN_PASS` stays the CI
  form. What changed: on 0.56.0, passing both `--admin-pass-file` and
  `--admin-pass` let the flag win silently; that combination is now a usage
  error, and the command sends nothing. A missing, empty, or
  group-/world-readable file is refused naming the path and its mode.

  > **Heads-up:** if a script or unit file passes `--admin-pass-file` together
  > with `--admin-pass`, it now exits non-zero before any request. Pass exactly
  > one; prefer `--admin-pass-file`.

  (Refs #1910)
