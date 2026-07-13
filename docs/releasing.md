# Releasing Flair

Flair publishes eight workspace packages to npm under `@tpsdev-ai/*`. Releases are
**tokenless** and **staged**: CI authenticates to npm with a short-lived OIDC token
(no `NPM_TOKEN` lives anywhere) and submits each package to npm's **staging** area.
A maintainer then approves the staged tarballs on npmjs.com with 2FA to make them live.

> `flair-bench` is version-bumped and tagged in lockstep with the other 7, but stages
> in its own step in CI (allowed to fail) until its one-time bootstrap is done — see
> [flair-bench bootstrap](#flair-bench-bootstrap-one-time) below.

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
# promote ## Unreleased to the new version in CHANGELOG.md first, then:
./scripts/release.sh 0.11.0
```

This bumps every workspace package to the version, aligns internal deps, refreshes
`bun.lock`, builds, tests, and opens a `release: v0.11.0` PR. Review and merge it
(CI green + K&S approval) the same as any other PR.

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
3. Verifies all 7 `package.json` files are at that version.
4. Builds every package.
5. Runs `npm stage publish` for each package in dependency order (flair-client first).

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
empty release — so always promote `## [Unreleased]` to `## [X.Y.Z]` in the release PR.

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

There are seven lockstep-staged packages, so seven approvals (the web UI lists them on
one page). Approve in dependency order if installing immediately — flair-client before
its dependents — though staging does not itself resolve dependencies. `flair-bench`
stages separately and only appears here once its bootstrap (below) is done.

Verify when done:

```bash
npm view @tpsdev-ai/flair version   # should report the new version
```

## One-time setup

These are configured once and reused for every release.

### npm trusted publisher (per package)

For **each** of the seven packages, on npmjs.com → the package → **Settings → Trusted
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
`n8n-nodes-flair`, `langgraph-flair`.

> A package must already exist on npm before a trusted publisher can be added — all
> seven already do. This account-level config can only be done by an npm org owner.
> `flair-bench` doesn't exist on npm yet (verified via `npm view @tpsdev-ai/flair-bench`
> → 404 as of 2026-07-13) so it can't have a Trusted Publisher yet either — see below.

### `flair-bench` bootstrap (one-time)

`flair-bench` (added 2026-07-12, flair#702) is wired into the version-bump/tag flow
(`scripts/release.sh`, `release-publish.yml`'s version-check) alongside the other 7, but
`npm stage publish` categorically requires the package already exist on the npm registry
(`npm help stage`: "Package must exist"), and a Trusted Publisher can only be registered
for a package that already exists — chicken-and-egg for a brand-new package. Until an npm
org owner does this once, the workflow's dedicated "Stage-publish flair-bench" step is
expected to fail (it's `continue-on-error: true` so it doesn't block the other 7):

1. From a machine logged into npm with 2FA: `cd packages/flair-bench && npm run build &&
   npm publish --access public` — one normal (non-staged) publish to create the package
   on the registry. Any valid semver works; the very next lockstep release will bump it
   to match the other 7 automatically (it's in `scripts/release.sh`'s `PACKAGES` array).
2. Add the Trusted Publisher for `@tpsdev-ai/flair-bench` using the same table as the
   other 7 above (org=`tpsdev-ai`, repo=`flair`, workflow=`release-publish.yml`,
   environment=`release`, allowed=`npm stage publish` only).
3. Remove `continue-on-error: true` from the "Stage-publish flair-bench" step in
   `release-publish.yml` once a tag push has staged it successfully.

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
