- **The `flair idp` command group now lives in `src/commands/idp.ts`.** Part of the `src/cli.ts` modularization epic (flair#1626, epic flair#1618), matching the federation, memory, soul, rem, fleet, and mcp splits: `src/cli.ts` binds shared helpers into the module and calls `register(program)`.

  Pure extraction — no behavior change. `test/unit-isolated/cli-surface-snapshot.test.ts` stays byte-green, which proves every `idp` subcommand (`add` / `list` / `remove` / `test`), flag, and `--help` rendering is identical, so no auth or identity-provider path moved.
