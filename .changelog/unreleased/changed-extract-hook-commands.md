- **The `flair hook` command group now lives in `src/commands/hook.ts`.** Part of the `src/cli.ts` modularization epic (flair#1627, epic flair#1618), matching the federation, memory, soul, rem, fleet, mcp, and idp splits: `src/cli.ts` binds shared helpers into the module and calls `register(program)`.

  Pure extraction — no behavior change. `test/unit-isolated/cli-surface-snapshot.test.ts` stays byte-green, which proves every `hook` subcommand (`install` / `uninstall` / `status`), flag, and `--help` rendering is identical. All hook mutation logic still lives in `src/hook-install.ts`.
