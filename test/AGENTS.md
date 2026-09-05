# Test lane map

Use [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the contributor command and
[the CI workflow](../.github/workflows/test.yml) for full-lane setup. Do not run
bare `bun test` across this repo: it mixes global mocks and service-dependent
suites. A focused `bun test test/unit/example.test.ts` is useful while editing,
but is not evidence that the complete lane passed.

| Location | Execution boundary |
|---|---|
| `unit/` plus top-level `*.test.ts` | root unit group; include both |
| `unit-isolated/` | one Bun process per file; process-global module mocks |
| `integration/` | real Harper; current server/CLI builds and lane prerequisites |
| `integration-isolated/` | one process per file |
| `integration-heavy/` | separate expensive lane, including model-dependent conformance |
| `e2e/` | Playwright, separate from Bun |
| `bench/` | benchmark-specific README, dataset/model/config identity |

Package tests also live under `packages/*/test/`. TypeScript consumers may need
the built `flair-client` workspace dependency. Python packages have separate
tooling. Do not infer coverage from the root unit group's pass count.

For reliable fixtures:

- Give subprocesses explicit test identities, paths and configuration. Ambient credentials or shell startup files must not decide a case's result.
- Keep shared-module mocks in the isolated lane. Test order must not supply missing mock exports.
- Use the Harper lifecycle helper for real instances and retain teardown. Avoid running service suites against production data directories.
- Assert behavior through the real boundary involved: HTTP verbs for resource authorization, packaged entry points for install behavior, connector payloads for context budgets.
- Keep source-text tripwires supplementary. Changing an implementation spelling should not erase the behavioral regression test.
- Report skipped model/platform cases and failed prerequisites explicitly. Distinguish a focused pass, a full-lane pass and a baseline failure.

Bootstrap conformance is shared in `helpers/mcp-conformance.ts`. Retrieval
equivalence and lexical latency tests already exist; extend them when changing
ranking, scope or index maintenance instead of inventing a second oracle.
