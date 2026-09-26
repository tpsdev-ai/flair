# Releasing Flair

Flair publishes nine workspace packages to npm under `@tpsdev-ai/*`. Releases are
**tokenless** and **staged**: CI authenticates to npm with a short-lived OIDC token
(no `NPM_TOKEN` lives anywhere) and submits each package to npm's **staging** area
**under the `staged` tag** (never straight to `latest`). A maintainer then approves
the staged tarballs on npmjs.com with 2FA. Approval makes the version public, but
**not `latest`** — a credential-less post-publish canary installs that exact version
from the registry and boots it on Linux and macOS. Only a canary PASS prints the
sha256-bound promote commands that move `latest` — one per lockstep package, all
or none; the canary runs on the same definition of "it boots" the rockit ritual
uses (`scripts/ci/check-instance-boot.sh`).

The staging tag is an **immutable property of the staged package** (`npm help stage`):
re-staging the same version under a different tag requires `npm stage reject` first.
There is no "fix the stage in place" — you reject it and re-cut the next patch.

> `flair-bench` is version-bumped and tagged in lockstep with the other 7, and stages in
> its own step in CI for [historical reasons](#flair-bench-bootstrap-one-time-done). That
> step is no longer allowed to fail: every already-published package must stage
> for a release to pass.

```
 merge release PR ──▶ push tag v0.11.0 ──▶ CI stages all packages (tag: staged)
                                                                          │
                                                  maintainer reviews + approves (2FA)
                                                                          ▼
                                            public on npm, NOT latest ──▶ post-publish canary
                                                                          │  installs the exact
                                                                          │  version + boots it
                                                       canary PASS ───────┘
                                                                          │
                                                    paste the emitted promote block
                                                                          ▼
                                                                  latest moves
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

**Nothing about the version is bumped by hand.** The version is declared outside
`package.json` too — `packages/flair-bench/src/version.ts` holds it as a `TOOL_VERSION`
constant — and `release.sh` bumps every such site. It checks them *before* creating the
branch, so an out-of-sync tree aborts while nothing has been touched, and again after the
bump so a missed site can't be committed. The same check runs in CI
(`node scripts/check-version-sync.mjs`) and fails on any file outside the known set that
declares the release version, so a new version-bearing file is caught on the PR that adds
it. If you ever find yourself editing a version constant by hand during a release, that is
a bug in the script — add the file to `SOURCE_VERSION_FILES` in
`scripts/check-version-sync.mjs` and to the `git add` list in `scripts/release.sh`.

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

> The [`release-auto-tag`](../.github/workflows/release-auto-tag.yml) workflow
> normally pushes this tag for you once a release PR merges green (see
> [#1928](https://github.com/tpsdev-ai/flair/issues/1928)); the hand-push above is
> the manual fallback. When the release commit's tree carries
> `packages/adk-flair/pyproject.toml` at the same version, the auto-tagger ALSO
> creates `adk-flair-v<version>` from the same commit — so the PyPI publish run
> then needs only the environment gate its owner keeps or drops (no hand-pushed
> `adk-flair-v` tag). A tree whose `pyproject.toml` version differs refuses
> `adk-version-mismatch` before either tag is written; an `adk-flair-v<version>`
> that already exists at another commit refuses `adk-tag-exists-elsewhere`; and a
> second POST rejected for lack of permission refuses `adk-ref-write-rejected`
> with the `v` tag left in place. The App must be listed as a bypass actor on the
> `adk-flair-v*` tag ruleset for that second POST to be allowed.

The tag push triggers the [`release-publish`](../.github/workflows/release-publish.yml)
workflow, which:

1. Resolves the version from the tag and validates it as semver.
2. Verifies the tagged commit is an ancestor of `main` (a tag can't ship un-merged code).
3. Verifies every lockstep package's `package.json` is at that version.
4. Builds every package.
5. Runs `npm stage publish` for each lockstep package in dependency order
   (flair-client first), then `flair-bench` in its own step. Any lockstep package
   failing to stage fails the release.

It authenticates via OIDC — no secrets, and it does **not** create or move any tag (the
tag you pushed is the trigger). Watch the run; when it's green, the packages are staged
but **not yet live**.

In parallel — and **independent of the npm staging approval** — a `github-release` job
auto-cuts a [GitHub release](https://github.com/tpsdev-ai/flair/releases) for the tag.
Release notes are a **lede + links** rendering of the matching `## [X.Y.Z]` section
(`scripts/changelog-release-notes.mjs`): each entry keeps its bold lede, up to three
issue links, and any `> **Heads-up:**` operator lines. The deep record stays in
`CHANGELOG.md` and is linked from the footer at that tag. It is idempotent: re-running
the workflow or re-pushing the tag updates the existing release rather than failing.
The GitHub release documents the tagged commit immediately; it does not wait on the
npm 2FA gate. If the CHANGELOG has no section for the version, this job fails loudly
rather than cutting an empty release — which is why phase 1's fragment assembly
refuses to produce an empty section rather than letting the failure surface here,
after the tag is already pushed.

> `workflow_dispatch` with a `version` input remains as a manual fallback (needs
> `Actions: write`), but the tag push is the normal path.

### Phase 3 — approve the staged packages

Go to **[npmjs.com → tpsdev-ai → Staged Packages](https://www.npmjs.com/settings/tpsdev-ai/staging)**,
review each staged tarball, and approve with 2FA. Or from a machine logged into npm:

```bash
npm stage list            # show staged packages + their stage-ids
npm stage view <stage-id> # inspect one
npm stage approve <stage-id>   # 2FA prompt; package is made public under `staged`
```

The lockstep set is nine today (`node scripts/ci/lockstep-packages.mjs` prints the
list), so that many approvals (the web UI lists them on one page). Approve in dependency
order if installing immediately — flair-client before its dependents — though staging
does not itself resolve dependencies.

Approval makes each version **public but not `latest`**: a user who runs the bare
`npm install -g @tpsdev-ai/flair` still gets the previous `latest` until the promote
step below. That window is what the canary uses.

The staging tag is immutable — if a staged package is wrong, **reject** it
(`npm stage reject <stage-id>` on npmjs.com) and cut the next patch. The same version
cannot be re-staged under a different tag.

### Phase 4 — run the post-publish canary

The moment the staged packages are approved, dispatch the
[`post-publish canary`](../.github/workflows/canary.yml) (Actions → "Post-publish canary
— install + boot a published version") with two inputs:

| Input | Value |
| ----- | ----- |
| `version` | the version just approved, exact (e.g. `vX.Y.Z` without the `v`) |
| `expected_sha256` | the published tarball's sha256 (64 hex). The canary computes it from the registry with `node scripts/ci/registry-tarball-sha256.mjs <ver>`. |

The canary runs on clean `ubuntu-latest` and `macos-latest` runners and is
**credential-less**: it installs `@tpsdev-ai/flair@<ver>` by exact version from the
public registry, downloads the published tarball and verifies its sha256 equals
`expected_sha256` (npm exposes no sha256 directly — `dist.shasum` is a SHA-1), runs
the four install-tree assertions (`scripts/check-global-install-lockfile.mjs
--registry-version`), and boots the installed instance
(`scripts/ci/check-instance-boot.sh`: init with a 0600 pass file → adopt → `/Health`
from the supervised process → `flair doctor` → descriptors → clean stop).

It then installs the published `@tpsdev-ai/flair-mcp@<ver>` and
`@tpsdev-ai/flair-client@<ver>` (exact version, never a dist-tag) into a throwaway
prefix, writes the documented host config (`npx -y @tpsdev-ai/flair-mcp@<ver>`),
and drives a real `memory_store` → `memory_get` tool-call against the canary-booted
instance (`scripts/ci/check-plugin-canary.mjs`). That is the path a host actually
runs — not an in-process import of this checkout. A missing registry package, a
host that never comes up, or any other unmeasurable result is a FAIL, not a skip.

Nothing about the canary is optional. There is no `continue-on-error`, and an
unmeasurable run (registry lag, runner outage) is a FAIL, not a skip — a check that did
not run must not read as a pass.

### Phase 5 — promote `latest` (or deprecate)

The promote is **lockstep**: every package the release staged moves together, or
none does. `flair` at `latest` 0.55.1 while `flair-client` / `flair-mcp` / the
plugins sit at 0.54.2 is exactly the mismatch `flair#1383` detects at runtime —
and 0.55.1's promote had to be assembled by hand, line by line, for this reason.

- **On PASS**, the canary emits the complete, sha256-bound promote block as ONE
  snippet to paste once, from a repo checkout on a machine logged into npm. It
  runs in two phases: it verifies EVERY package's published-tarball sha256 first
  (so a registry hiccup mid-paste touches no tag), then runs the `npm dist-tag
  add` lines — `@tpsdev-ai/flair` LAST, so a partial paste never leaves the CLI
  ahead of its client library — then the skew check. Under 2FA each `dist-tag add`
  may prompt for an OTP separately, so capture one code and pass it to all of them
  with `--otp`:

  ```bash
  set -e
  OTP=123456   # fresh from your authenticator; valid for a short window

  # 1. Preflight — every published tarball must hash to its recorded sha256.
  test "$(node scripts/ci/registry-tarball-sha256.mjs <ver> @tpsdev-ai/flair-client)" = "<sha>"
  test "$(node scripts/ci/registry-tarball-sha256.mjs <ver> @tpsdev-ai/flair-mcp)"    = "<sha>"
  # … one line per lockstep package; @tpsdev-ai/flair last …
  test "$(node scripts/ci/registry-tarball-sha256.mjs <ver> @tpsdev-ai/flair)"        = "<sha>"

  # 2. Promote every lockstep package (`@tpsdev-ai/flair` LAST).
  npm dist-tag add @tpsdev-ai/flair-client@<ver> latest --otp "$OTP"
  npm dist-tag add @tpsdev-ai/flair-mcp@<ver> latest --otp "$OTP"
  # … one line per lockstep package …
  npm dist-tag add @tpsdev-ai/flair@<ver> latest --otp "$OTP"

  # 3. Confirm the set converged.
  node scripts/ci/registry-latest-skew.mjs <ver>
  ```

  The preflight `test` guards integrity: a stale PASS, a re-cut version, or a
  paste from a failed run aborts before `latest` moves. Paste **all** of the block
  or **none** — a partial paste is the skew this phase exists to prevent.

  The block runs under bash; `scripts/ci/canary-verdict.sh` is bash **3.2**-safe,
  so stock macOS `/bin/bash` runs it (and the emitted block) locally — no newer
  bash required. Anything older than 3.2 fails fast with a clear message.
- **Confirm the set converged** — the last step, after pasting:

  ```bash
  node scripts/ci/registry-latest-skew.mjs <ver>
  ```

  It reads `dist-tags.latest` for every lockstep package and exits non-zero
  naming any that disagree (or that differ from `<ver>`). The canary runs the same
  check BEFORE the verdict, so a pre-existing skew is visible there too.
- **On FAIL**, the version stays public but unpromoted. The canary emits one
  `npm deprecate` line per package; run them, then re-cut the next patch. A
  version is never refreshed in place.

## One-time setup

These are configured once and reused for every release.

### npm trusted publisher (per package)

For **each** lockstep package (nine today; `node scripts/ci/lockstep-packages.mjs`
prints the list), on npmjs.com → the package → **Settings → Trusted
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

Lockstep packages: the list `node scripts/ci/lockstep-packages.mjs` prints (root +
`packages/*` that are not `private`). `flair-tool-descriptors` is private and never
published; since flair#1683 it is a
> **build-time source**: `scripts/vendor-tool-descriptors.mjs` copies it into each
> consumer's own tree at prebuild (`resources/tool-descriptors/` for `flair`,
> `packages/flair-mcp/src/tool-descriptors/` for `flair-mcp`) and the consumers
> import it by relative path. Nothing declares or bundles it as a dependency —
> 0.54.1's `bundleDependencies` broke fresh global installs (flair#1681 → #1683).

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

### Required status checks (ruleset)

Add **`First-publish preflight`** to the main branch ruleset's required status
checks (repo settings → Rules → main). This is a repo-settings act, not a code
change: until it is listed, the release-PR job is **advisory only** and a red
first-publish preflight can be merged past. The tag-triggered
`release-publish.yml` also runs the same check before staging, so a hazard is
still stopped on the normal release path either way.

### Approver 2FA

The maintainer who approves staged packages must have 2FA enabled on their npm account.

## If something goes wrong

- **A staged package looks wrong** — reject it on npmjs.com instead of approving; it
  never goes live. Fix forward on `main` and cut a new patch version.
- **Re-run the stage for the same version** — you cannot. The `staged` tag is an
  immutable property of the staged package, so re-stage requires reject first. Reject
  the staged package(s) on npmjs.com, then cut and tag the next patch version; a
  re-pushed tag re-triggers the workflow for that new version.
- **Break-glass (CI down):** `./scripts/release.sh X.Y.Z --publish` still works from a
  machine logged into npm. Prefer the staged flow; this bypasses the staging gate.

## Requirements

- npm CLI **≥ 11.15.0** (`npm stage`) and **≥ 11.5.1** (OIDC) — the workflow upgrades
  npm itself; local approvers need a recent npm.
- Node **≥ 22.14**.
- Trusted publishing runs on GitHub-hosted runners only (no self-hosted support yet).
