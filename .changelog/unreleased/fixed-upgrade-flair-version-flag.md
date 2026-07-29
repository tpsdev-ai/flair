- **`flair upgrade --target <url> --version <semver>` silently upgraded nothing.**
  Commander matches an option against a parent command's own list before
  dispatching to the subcommand, so `--version` was caught by the program's
  global `-v, --version`: the CLI printed its own version and exited 0 without
  ever running the Fabric upgrade. The flag is now **`--flair-version <semver>`**
  (matching the existing `--harper-version`). `--version` keeps its usual
  meaning of printing the CLI version.
