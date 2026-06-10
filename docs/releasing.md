# Releasing Flair

Flair publishes seven workspace packages to npm under `@tpsdev-ai/*`. Releases are
**tokenless** and **staged**: CI authenticates to npm with a short-lived OIDC token
(no `NPM_TOKEN` lives anywhere) and submits each package to npm's **staging** area.
A maintainer then approves the staged tarballs on npmjs.com with 2FA to make them live.

```
 merge release PR ──▶ gh workflow run release-publish.yml ──▶ npm staging
                                                                  │
                                          maintainer reviews + approves (2FA)
                                                                  ▼
                                                              live on npm
```

This replaces the old "run `release.sh --publish` from a laptop logged into npm" flow.
Nothing publishes without a human 2FA approval, and every package ships with a
provenance attestation (public repo → verifiable build origin).

## Cutting a release

### Phase 1 — open the release PR

```bash
# promote ## Unreleased to the new version in CHANGELOG.md first, then:
./scripts/release.sh 0.11.0
```

This bumps every workspace package to the version, aligns internal deps, refreshes
`bun.lock`, builds, tests, and opens a `release: v0.11.0` PR. Review and merge it
(CI green + K&S approval) the same as any other PR.

### Phase 2 — stage-publish from CI

After the release PR is merged to `main`:

```bash
gh-as flint workflow run release-publish.yml -f version=0.11.0
```

The [`release-publish`](../.github/workflows/release-publish.yml) workflow:

1. Checks out `main`, verifies all 7 `package.json` files are at the requested version
   and that tag `vX.Y.Z` does not already exist.
2. Builds every package.
3. Runs `npm stage publish` for each package in dependency order (flair-client first).
4. Tags `vX.Y.Z` and pushes the tag.

It authenticates via OIDC — no secrets. Watch the run; when it's green, the packages
are staged but **not yet live**.

### Phase 3 — approve the staged packages

Go to **[npmjs.com → tpsdev-ai → Staged Packages](https://www.npmjs.com/settings/tpsdev-ai/staging)**,
review each staged tarball, and approve with 2FA. Or from a machine logged into npm:

```bash
npm stage list            # show staged packages + their stage-ids
npm stage view <stage-id> # inspect one
npm stage approve <stage-id>   # 2FA prompt; package goes live
```

There are seven packages, so there are seven approvals (the web UI lists them on one
page). Approve in dependency order if installing immediately — flair-client before its
dependents — though staging does not itself resolve dependencies.

Verify when done:

```bash
npm view @tpsdev-ai/flair version   # should report the new version
```

## One-time setup

These are configured once and reused for every release.

### npm trusted publisher (per package)

For **each** of the seven packages, on npmjs.com → the package → **Settings → Trusted
Publisher → Add**:

| Field         | Value                  |
| ------------- | ---------------------- |
| Provider      | GitHub Actions         |
| Organization  | `tpsdev-ai`            |
| Repository    | `flair`                |
| Workflow      | `release-publish.yml`  |
| Environment   | `release`              |

Packages: `flair-client`, `flair-mcp`, `flair`, `openclaw-flair`, `pi-flair`,
`n8n-nodes-flair`, `langgraph-flair`.

> A package must already exist on npm before a trusted publisher can be added — all
> seven already do. This account-level config can only be done by an npm org owner.

### GitHub `release` environment

A repository environment named `release` scopes the OIDC trust and restricts the
workflow to `main`. It has **no required reviewers** — the human gate is the npm
staging approval, not a GitHub deployment review. (Settings → Environments → `release`,
deployment branch policy: `main` only.)

### Approver 2FA

The maintainer who approves staged packages must have 2FA enabled on their npm account.

## If something goes wrong

- **A staged package looks wrong** — reject it on npmjs.com instead of approving; it
  never goes live. Fix forward on `main` and re-run phase 2 with a new patch version.
- **The workflow tagged `vX.Y.Z` but you rejected the stage** — delete the tag
  (`git push origin :vX.Y.Z`) before re-cutting, or the version-exists guard will block
  the re-run.
- **Break-glass (CI down):** `./scripts/release.sh X.Y.Z --publish` still works from a
  machine logged into npm. Prefer the staged flow; this bypasses the staging gate.

## Requirements

- npm CLI **≥ 11.15.0** (`npm stage`) and **≥ 11.5.1** (OIDC) — the workflow upgrades
  npm itself; local approvers need a recent npm.
- Node **≥ 22.14**.
- Trusted publishing runs on GitHub-hosted runners only (no self-hosted support yet).
