- **`flair mcp enable` refuses a target that is neither a `*.harperfabric.com` host nor the instance on this machine, instead of taking the local restart branch.** (Closes #2189)

  A Harper Fabric instance reached through a custom domain takes the Fabric (operator-deploy) branch with the new `--fabric` flag.
