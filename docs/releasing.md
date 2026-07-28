# Releasing Flair

Flair publishes eight workspace packages to npm under `@tpsdev-ai/*`. Releases are
**tokenless** and **staged**: CI authenticates to npm with a short-lived OIDC token
(no `NPM_TOKEN` lives anywhere) and submits each package to npm's **staging** area.
A maintainer then approves the staged tarballs on npmjs.com with 2FA to make them live.

> `flair-bench` is version-bumped and tagged in lockstep with the other 7, and stages in
> its own step in CI for [historical reasons](#flair-bench-bootstrap-one-time-done). That
> step is no longer allowed to fail: all eight packages must stage for a release to pass.

```
 merge release PR ──▶ push tag v0.11.0 ──▶ CI stages all packages ──▶ npm staging
                                                                          │
                                                  maintainer reviews + approves (2FA)
                                                                          ▼
                                                                      live on npm
```

Pushing a `vX.Y.Z` tag triggers the release. This replaces the old "run
`release.sh --publish` from a laptop logged into npm" flow. Nothing publishes without
a human 2FA approval, and every package ships with a provenance attestation (public
repo → verifiable build origin). The person who tags the release does **not** need npm
credentials or `Actions: write` — only repo push access; the only privileged step is
the maintainer's 2FA approval.

## Cutting a release

### Phase 1 — open the release PR

```bash
./scripts/release.sh 0.11.0
```

This assembles the changelog, bumps every workspace package to the version, aligns
internal deps, refreshes `bun.lock`, builds, tests, and opens a `release: v0.11.0` PR.
Review and merge it (CI green + K&S approval) the same as any other PR.

**The changelog is assembled, not hand-promoted.** Entries land during development as one
file per change under `.changelog/unreleased/` (flair#835 — a shared `[Unreleased]` block
conflicted on every concurrent PR, and resolving a conflict dismisses approvals). The
release script runs:

```bash
node scripts/changelog-fragments.mjs promote 0.11.0
```

which writes a `## [0.11.0] - <date>` section from the fragments — Keep a Changelog category
order, filename order within a category, entry bodies copied verbatim — and deletes the
fragment files. Released history above it is not touched. It **refuses** to run when the
fragment directory is empty (nothing to release) or when someone hand-wrote an entry into
`## [Unreleased]` that the step would otherwise silently overwrite. Preview any time with
`node scripts/changelog-fragments.mjs render`.

### Phase 2 — tag the release

After the release PR is merged to `main`, push the version tag:

```bash
git checkout main && git pull
git tag v0.11.0 && git push origin v0.11.0
```

The tag push triggers the [`release-publish`](../.github/workflows/release-publish.yml)
workflow, which:

1. Resolves the version from the tag and validates it as semver.
2. Verifies the tagged commit is an ancestor of `main` (a tag can't ship un-merged code).
3. Verifies all 8 `package.json` files are at that version.
4. Builds every package.
5. Runs `npm stage publish` for each package in dependency order (flair-client first),
   then `flair-bench` in its own step. Any one of the eight failing fails the release.

It authenticates via OIDC — no secrets, and it does **not** create or move any tag (the
tag you pushed is the trigger). Watch the run; when it's green, the packages are staged
but **not yet live**.

In parallel — and **independent of the npm staging approval** — a `github-release` job
auto-cuts a [GitHub release](https://github.com/tpsdev-ai/flair/releases) for the tag,
using the matching `## [X.Y.Z]` section of `CHANGELOG.md` as the release notes (extracted
by `scripts/changelog-extract.mjs`). It is idempotent: re-running the workflow or
re-pushing the tag updates the existing release rather than failing. The GitHub release
documents the tagged commit immediately; it does not wait on the npm 2FA gate. If the
CHANGELOG has no section for the version, this job fails loudly rather than cutting an
empty release — which is why phase 1's fragment assembly refuses to produce an empty
section rather than letting the failure surface here, after the tag is already pushed.

> `workflow_dispatch` with a `version` input remains as a manual fallback (needs
> `Actions: write`), but the tag push is the normal path.

### Phase 3 — approve the staged packages

Go to **[npmjs.com → tpsdev-ai → Staged Packages](https://www.npmjs.com/settings/tpsdev-ai/staging)**,
review each staged tarball, and approve with 2FA. Or from a machine logged into npm:

```bash
npm stage list            # show staged packages + their stage-ids
npm stage view <stage-id> # inspect one
npm stage approve <stage-id>   # 2FA prompt; package goes live
```

There are eight lockstep-staged packages, so eight approvals (the web UI lists them on
one page). Approve in dependency order if installing immediately — flair-client before
its dependents — though staging does not itself resolve dependencies.

Verify when done:

```bash
npm view @tpsdev-ai/flair version   # should report the new version
```

## One-time setup

These are configured once and reused for every release.

### npm trusted publisher (per package)

For **each** of the eight packages, on npmjs.com → the package → **Settings → Trusted
Publisher → Add**:

| Field           | Value                       |
| --------------- | --------------------------- |
| Provider        | GitHub Actions              |
| Organization    | `tpsdev-ai`                 |
| Repository      | `flair`                     |
| Workflow        | `release-publish.yml`       |
| Environment     | `release`                   |
| Allowed actions | **`npm stage publish` only** |

Leave `npm publish` **unchecked** under allowed actions. This structurally prevents the
CI/OIDC identity from publishing anything live directly — the only path to live is the
human 2FA approval of a staged package.

Packages: `flair-client`, `flair-mcp`, `flair`, `openclaw-flair`, `pi-flair`,
`n8n-nodes-flair`, `langgraph-flair`, `flair-bench`.

> A package must already exist on npm before a trusted publisher can be added — all
> eight already do. This account-level config can only be done by an npm org owner.

### `flair-bench` bootstrap (one-time, done)

**Nothing to do here.** This section is kept because the next brand-new package added to
the release set will hit the same wall, and because it explains why `flair-bench` still
stages in its own workflow step.

`flair-bench` (added 2026-07-12, flair#702) was wired into the version-bump/tag flow
(`scripts/release.sh`, `release-publish.yml`'s version-check) alongside the other 7 before
it existed on npm at all. That is a chicken-and-egg: `npm stage publish` categorically
requires the package to already exist on the registry (`npm help stage`: "Package must
exist"), and a Trusted Publisher can only be registered for a package that already exists.
So the workflow gave it a dedicated "Stage-publish flair-bench" step marked
`continue-on-error: true`, letting the expected failure pass without blocking the other 7,
and an npm org owner broke the cycle once:

1. One normal (non-staged) `npm publish --access public` from a machine logged into npm
   with 2FA, to create the package on the registry. Any valid semver works — the next
   lockstep release bumps it to match the other 7 automatically.
2. Add its Trusted Publisher using the same table as the other packages above.

Both are done, and the step staged `@tpsdev-ai/flair-bench` successfully at v0.30.0, so
`continue-on-error` has been **removed**: a flair-bench staging failure now fails the
release like any other package's.

> Why it mattered to go back and remove it: `continue-on-error: true` makes a step report
> `conclusion: success` even when it failed. While it was set, a green run was not evidence
> that flair-bench had staged — the only way to know was to read the raw log. A justified
> exception outlives the condition that justified it unless someone returns for it.

### GitHub `release` environment

A repository environment named `release` scopes the OIDC trust. It has **no required
reviewers** — the human gate is the npm staging approval, not a GitHub deployment
review. Because the release is triggered by a tag push, its deployment policy must allow
**`v*` tags** (Settings → Environments → `release` → Deployment branches and tags →
Selected branches and tags → add tag rule `v*`).

### Approver 2FA

The maintainer who approves staged packages must have 2FA enabled on their npm account.

## If something goes wrong

- **A staged package looks wrong** — reject it on npmjs.com instead of approving; it
  never goes live. Fix forward on `main` and cut a new patch version.
- **Re-run the stage for the same version** — delete and re-push the tag
  (`git push origin :v0.11.0` then `git tag -f v0.11.0 && git push origin v0.11.0`).
  The tag push re-triggers the workflow.
- **Break-glass (CI down):** `./scripts/release.sh X.Y.Z --publish` still works from a
  machine logged into npm. Prefer the staged flow; this bypasses the staging gate.

## Requirements

- npm CLI **≥ 11.15.0** (`npm stage`) and **≥ 11.5.1** (OIDC) — the workflow upgrades
  npm itself; local approvers need a recent npm.
- Node **≥ 22.14**.
- Trusted publishing runs on GitHub-hosted runners only (no self-hosted support yet).
