- **Outside `--dry-run`, `flair mcp enable` refuses non-loopback target URLs unless the host ends in `.harperfabric.com` or `--fabric` is set.** (Closes #2189)

  `--fabric` selects the Fabric branch, defaults to Fabric secrets staging, and refuses `--cimd-allowed-hosts`.
