# Contributing to Flair

Thanks for your interest. Flair is open-source under Apache 2.0; contributions are welcome across code, docs, and bridges.

## Quick orientation

| You want to... | Start here |
|----------------|------------|
| Report a bug | [Open an issue](https://github.com/tpsdev-ai/flair/issues/new) — include `flair --version`, OS, and the steps to reproduce |
| Propose a feature | Open a discussion or issue first; large PRs without prior alignment are hard to land |
| Fix a typo or a doc rough edge | Just open a PR — no issue needed |
| Write a new bridge | See [docs/bridges.md](docs/bridges.md) — scaffold with `flair bridge scaffold <name>` and publish as `flair-bridge-<name>` on npm |
| Report a security issue | See [SECURITY.md](SECURITY.md) — **do not** open a public issue |

## Local setup

Flair is a Node.js monorepo with a single Harper v5 runtime and three published packages.

```bash
git clone https://github.com/tpsdev-ai/flair.git
cd flair
npm install
npm run build && npm run build:cli
```

Run the test suite:

```bash
bun test                  # unit + integration; no external services needed
bun test test/unit        # faster — unit only
bun test test/integration # slower — exercises Harper lifecycle
```

Playwright e2e tests live under `test/e2e/` and run separately (`npm run test:e2e`). They're not required for most PRs; the `bun test` suite covers the main paths.

Run the CLI against a local Flair instance:

```bash
./dist/cli.js --help
./dist/cli.js init --data-dir /tmp/flair-dev --port 19926
./dist/cli.js status --port 19926
```

## PR expectations

Flair's main branch is protected. Landing a change means:

1. **CI green.** Unit tests, integration tests, type-check, Semgrep SAST, and install-from-tarball smoke all pass.
2. **Reviewed.** Each PR gets one architecture review and one security review. Both must approve.
3. **Squash-merged.** Clean history; the PR body becomes the commit message.

Before opening a PR:

- Match the existing code style. We don't run a formatter; follow the surrounding conventions.
- Keep commits logically grouped. A PR with one focused change is easier to review than a PR with eight unrelated ones.
- Add tests for any new behavior. Unit tests live in `test/unit/`, integration tests in `test/integration/`.
- Update [CHANGELOG.md](CHANGELOG.md) under `## Unreleased` if the change is user-visible.
- Reference a bead or issue in the PR body when one exists.

## What to avoid

- **Breaking the memory record schema.** The fields listed in `src/bridges/types.ts` under `FLAIR_RESERVED_FIELDS` are computed by Flair on ingest; adding new reserved fields or changing existing ones is an architectural change that needs a design-review conversation first.
- **Vendor lock-in.** Flair is model-agnostic and runtime-agnostic. Don't introduce hard dependencies on a specific LLM vendor, cloud provider, or agent framework. Compose with them, don't couple to them.
- **Silent behavior changes.** If a release changes what an existing flag or command does, call it out in CHANGELOG and in the PR body.

## Bridges

Bridges are the easiest way to contribute — they extend Flair to new ecosystems without touching core code.

Two shapes:

- **File (YAML descriptor)** — no TypeScript required; declare the mapping from a foreign file format to the Flair memory schema.
- **API (code plugin)** — for foreign systems with HTTP APIs. Ship as `flair-bridge-<name>` on npm.

Start with:

```bash
flair bridge scaffold my-system --file   # or --api
flair bridge list                        # confirm it's discovered
# edit the descriptor + fixture, then:
flair bridge test my-system              # round-trip diff
```

Full contract in [docs/bridges.md](docs/bridges.md) and the spec at [specs/FLAIR-BRIDGES.md](specs/FLAIR-BRIDGES.md). The round-trip test is the signal — if it passes, the bridge is ready.

## Releases

Releases are two-phase and driven by `scripts/release.sh`:

```bash
./scripts/release.sh 0.7.0           # Phase 1: bumps, builds, opens release PR
# ... review and merge the PR on GitHub ...
./scripts/release.sh 0.7.0 --publish  # Phase 2: publishes to npm, tags, pushes tag
```

Update `CHANGELOG.md` to promote `## Unreleased` to the new version before running phase 2.

## Questions

Open a discussion or issue. Flair is small enough that every question is welcome — "is this the right pattern?" is a better PR comment than a follow-up bug.
