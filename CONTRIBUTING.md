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

Flair is a Node.js monorepo with a single Harper v5 runtime and workspace packages under `packages/`.

```bash
git clone https://github.com/tpsdev-ai/flair.git
cd flair
npm install
npm run build && npm run build:cli
```

Run the shared unit lane before pushing:

```bash
bun install --frozen-lockfile
bun run test:unit          # root, isolated and TypeScript package unit tests
bun run test:unit --list   # show discovery and process boundaries without running
```

`bun run test` and `npm test` use this same runner. CI and the release script
also call it. It builds `flair-client` before package consumers and runs each
`test/unit-isolated/` file in a fresh process. The runner stops on failure and
prints the failed step; Bun reports pass/skip counts for each test process.
Node.js must be on PATH for builds and subprocess tests. Use the Bun version
in `packageManager` for CI parity.

Child processes start without ambient `FLAIR_*`, `HARPER_*`, `HDB_*` or
`FABRIC_*` deployment settings; tests set their own fixture configuration.
This is not a network sandbox: tests must still mock external calls explicitly.

Do not use bare `bun test` as the repository-wide validation command: it bypasses
the runner and mixes suites with incompatible global mocks and prerequisites.
For a focused change, `bun test test/unit/example.test.ts` still works, but does
not replace the shared lane. Known local ordering/pollution failures are tracked
in #1493; this runner standardizes invocation rather than suppressing failures.

Integration tests start real Harper processes and require built server/CLI
artifacts; model-dependent suites also require the embedding model. Run them on
an isolated development host using the setup in `.github/workflows/test.yml`.
`test/integration-isolated/` needs one process per file, and
`test/integration-heavy/` is a separate lane. Python package tests and Playwright
(`npm run test:e2e`) also run separately. The unit command does not claim those
checks passed.

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
- Add a **changelog fragment** if the change is user-visible: a new file
  `.changelog/unreleased/<category>-<slug>.md` holding the entry as it should read under its
  `### Category` heading. One file per change means two PRs never conflict on the changelog —
  `scripts/release.sh` assembles them into `CHANGELOG.md` at the version cut. Conventions and
  a preview command: [`.changelog/unreleased/README.md`](.changelog/unreleased/README.md).
  Don't edit `## [Unreleased]` in `CHANGELOG.md` by hand; the release step overwrites it.
- Reference a bead or issue in the PR body when one exists.

## What to avoid

- **Breaking the memory record schema.** The fields listed in `src/bridges/types.ts` under `FLAIR_RESERVED_FIELDS` are computed by Flair on ingest; adding new reserved fields or changing existing ones is an architectural change that needs a design-review conversation first.
- **Vendor lock-in.** Flair is model-agnostic and runtime-agnostic. Don't introduce hard dependencies on a specific LLM vendor, cloud provider, or agent framework. Compose with them, don't couple to them.
- **Silent behavior changes.** If a release changes what an existing flag or command does, call it out in a changelog fragment and in the PR body.

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

Full contract in [docs/bridges.md](docs/bridges.md). The round-trip test is the signal — if it passes, the bridge is ready.

## Releases

Releases are two-phase. **Phase 1** opens the version-bump PR; **phase 2** stages every
package to npm from CI — no local npm login. Full runbook: [docs/releasing.md](docs/releasing.md).

```bash
# Phase 1 — open the release PR (bumps every workspace package, builds, tests)
./scripts/release.sh 0.7.0
# ... review and merge the PR on GitHub ...

# Phase 2 — tag the merged release; the tag push triggers the stage-publish CI
git checkout main && git pull
git tag v0.7.0 && git push origin v0.7.0
```

Pushing the `vX.Y.Z` tag triggers the [`release-publish`](.github/workflows/release-publish.yml)
workflow: it authenticates to npm with a short-lived **OIDC** token (no stored `NPM_TOKEN`),
builds, and submits all packages to npm **staging** with provenance. They are **not live**
until a maintainer reviews the staged tarballs and **approves them on npmjs.com with 2FA** —
that approval is the release gate. Tagging needs only repo push access (no npm creds, no
`Actions: write`).

Phase 1 assembles every `.changelog/unreleased/` fragment into a `## [X.Y.Z]` section of
`CHANGELOG.md` and deletes the fragments — there is nothing to promote by hand. It refuses
to run if the fragment directory is empty. The legacy `./scripts/release.sh 0.7.0 --publish`
direct-publish path remains as a break-glass fallback for when CI is unavailable.

## Questions

Open a discussion or issue. Flair is small enough that every question is welcome — "is this the right pattern?" is a better PR comment than a follow-up bug.
