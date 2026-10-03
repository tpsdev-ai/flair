- **`flair principal link` maps one IdP login to a principal; `unlink` revokes a mapping; `links` lists current mappings.**
  `flair principal link <principal> --idp-subject <login>` refuses a missing principal by name, reports a
  subject already mapped to that principal without writing, and refuses a subject mapped to a different principal
  unless `--replace` moves it. More than one active principal mapped to the subject is refused before writing.
  `flair principal unlink <principal> --idp-subject <login>` defaults to provider `github`; pass
  `--idp-provider <name>` for a different provider. Unlink reports success only after confirmed updates and no resolvable subject mapping on readback.
