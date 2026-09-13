- **The `flair bridge` command group now lives in `src/commands/bridge.ts`.** Part of the `src/cli.ts` modularization epic (flair#1628, epic flair#1618), matching the federation, memory, soul, rem, fleet, mcp, idp, and hook splits: `src/cli.ts` binds shared helpers into the module and calls `register(program)`.

  Pure extraction — no behavior change. `test/unit-isolated/cli-surface-snapshot.test.ts` stays byte-green, which proves every `bridge` subcommand, flag, and `--help` rendering is identical. All bridge runtime logic still lives under `src/bridges/`.
