- **`flair mcp enable` refuses non-canonical targets before writes and supports custom-domain Fabric targets with `--fabric`.** (Closes #2189)

  `--fabric` selects the Fabric branch, defaults to Fabric secrets staging, and refuses `--cimd-allowed-hosts` and a localhost, `*.localhost`, 127/8, `::1`, `::ffff:127/8`, `0.0.0.0` or `::` host.
