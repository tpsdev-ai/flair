- **Outside `--dry-run`, `flair mcp enable` refuses a target URL unless its host is localhost, `*.localhost`, in 127/8, `::1` or `::ffff:127/8`, ends in `.harperfabric.com`, or `--fabric` is set.** (Closes #2189)

  `--fabric` selects the Fabric branch, defaults to Fabric secrets staging, and refuses `--cimd-allowed-hosts` and a localhost, `*.localhost`, 127/8, `::1` or `::ffff:127/8` host.
