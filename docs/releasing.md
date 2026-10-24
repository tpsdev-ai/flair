# Releasing Flair

Flair publishes nine workspace packages to npm under `@tpsdev-ai/*`. On the normal
staged-release path, CI authenticates to npm with a short-lived OIDC token and
submits each package to npm's **staging** area
**under the `staged` tag** (never straight to `latest`). A maintainer then approves
the staged tarballs on npmjs.com with 2FA. Approval makes the version public, but
**not `latest`** — a credential-less post-publish canary installs that exact version
from the registry and boots it on Linux and macOS. Only a canary PASS prints the
sha256-bound promote commands that move `latest` — one per lockstep package,
sequentially, stopping on failure; the canary runs on the same definition of
"it boots" that the maintainers' boot check uses (`scripts/ci/check-instance-boot.sh`).

The staging tag is an **immutable property of the staged package** (`npm help stage`):
re-staging the same version under a different tag requires `npm stage reject` first.
There is no "fix the stage in place" — you reject it and re-cut the next patch.

```
 merge release PR ──▶ auto-tag v0.11.0 ──▶ CI stages all packages (tag: staged)
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

One `vX.Y.Z` tag starts npm staging and the `adk-flair` PyPI workflow.
PyPI requires the matching `packages/adk-flair/pyproject.toml` version and approval
in the `adk-flair-publish` environment. `adk-flair-vX.Y.Z` remains available for
Python-only releases; `workflow_dispatch` remains the manual fallback.

## Cutting a release

### Phase 1 — open the release PR

```bash
./scripts/release.sh 0.11.0
```

This assembles the changelog, bumps the lockstep release packages (listed in
`scripts/release.sh`) to the version, aligns internal deps, refreshes `bun.lock`, builds,
tests, and opens a `release: v0.11.0` PR. The Cursor workspaces (`packages/cursor-flair`
and `packages/cursor-wake-runner`) keep their own versions.
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

After a release PR merges to `main`, [Release auto-tag](../.github/workflows/release-auto-tag.yml)
normally creates its tag after a successful push CI run on `main`, subject to the release checks.
If an allowlisted advisory job fails that CI run, the immediate path is skipped and
nightly recovery makes the tag instead. It runs at **04:23 UTC daily**, so expect up
to **24 hours plus run time**. It uses completed CI runs regardless of their overall
conclusion and tolerates only exact names in [the advisory allowlist](../.github/release-auto-tag-advisories.json).
All other release conditions must pass, and it targets the version still declared
on `main`, so a newer version supersedes a missed release.

If Release auto-tag refused, resolve what it reports; do not tag by hand. If it did not
run, a repository admin tags by hand (a ruleset restricts creating `v*` tags) once the
checks it applies pass. The first command must print nothing:

```bash
git ls-remote --tags origin v0.11.0
git checkout main && git pull
git tag v0.11.0 && git push origin v0.11.0
```

> When the release commit's tree carries
> `packages/adk-flair/pyproject.toml` whose `[project].version` equals the version
> being tagged, the auto-tagger ALSO creates `adk-flair-v<version>` from the same
> commit. PyPI runs serialize per version, upload missing artifacts after the guards pass,
> and verify both filenames and SHA256 digests; lookup errors fail the run.
>
> The project version is read with Python's `tomllib` — the SAME reader
> `.github/workflows/adk-flair-publish.yml` decides with — by handing the file to
> `python3` on stdin, in isolated mode (`-I`: no working-directory module can
> shadow the standard library) with an environment of `PATH` only, so no token
> reaches the interpreter ((r9e)). It fails CLOSED: a TOML parse error, a `python3` without
> `tomllib` (older than 3.11), or a `[project]` that is not a table is
> `unsupported`, and the tagger refuses `adk-pyproject-unsupported` naming the
> reason ((s), (v)); a `dynamic = [ … "version" … ]` or a missing
> `[project].version` is NONE and refuses `adk-version-mismatch` ((t)); a
> `[project].version` that differs from the version being tagged refuses
> `adk-version-mismatch` BEFORE either tag is written ((p), (q), (g)) — a
> `version =` line inside a multi-line string or array is never read as the
> project version. With NO `packages/adk-flair/pyproject.toml` the
> tagger's adk step is skipped ((b)), but `scripts/check-version-sync.mjs` lists the
> pyproject as a source file and refuses when it is missing, so today such a release
> refuses at `version-sync`. Removing the Python package from the repo means removing
> it, in the same change, from the checker's source list and from the paths
> `scripts/release.sh` stages for the release commit; a release is then tagged `v`
> alone. An
> `adk-flair-v<version>` already at another commit refuses
> `adk-tag-exists-elsewhere` before the `v` tag is written ((d)); a second POST
> rejected for lack of permission refuses `adk-ref-write-rejected`, and the text
> reports what THIS run read back for BOTH refs and the next step ((e)): for a 403
> the text names the App's bypass-actor setting on the `adk-flair-v*` ruleset as the
> first thing to check (the usual cause; the code sees only the status), then a
> re-run; for any other status, a re-run ((r9a)). A read of the adk ref that FAILS
> (the API answers neither found nor not found) refuses `adk-ref-unreadable` instead
> of throwing: before any tag is written at the pre-check and on a same-commit re-run
> ((r9b), (r9f), (r9g)), and with the `v` tag in place at the re-read and the
> read-back ((r9c), (r9d)). After a REJECTED adk POST the refusal stays
> `adk-ref-write-rejected`, and the text reports the adk read-back as
> `not read: <reason>`; when the adk read-back cannot be resolved, the text reports its raw
> ref type and SHA (or `not found`), so it names BOTH refs' read-back values on every
> branch. The post-POST read-back has THREE refusals, each reporting only
> what this run observed: the adk ref did not read back at all (MISSING, (i2)); it
> read back but could not be resolved to a commit (UNRESOLVED, (i3)); or it
> resolves elsewhere (ELSEWHERE, (i)). None states what a future run will do. The
> membership+read of the pyproject is ONE function (`readAdkPyproject`): a
> `git ls-tree` that does not answer exactly "absent" or "the path" (non-zero exit,
> spawn error, timeout, unexpected output) or a failed `git show` refuses
> `adk-pyproject-unreadable` — before any POST, on BOTH the decide and write paths
> ((r1)-(r4)); no stderr substring decides anything.
>
> The writer (`scripts/check-version-sync.mjs --write`) precomputes the two
> `SOURCE_VERSION_FILES` edits — `packages/flair-bench/src/version.ts` and
> `packages/adk-flair/pyproject.toml` — verifies the pyproject edit with `tomllib`
> (refused unless only `project.version` changed) and the flair-bench edit with its
> own declaration check (exactly one `TOOL_VERSION = "…"` match), writes NOTHING if
> either fails, and leaves the `package.json` bumps to `release.sh` ((w), (x2), (m),
> (h), all-or-nothing).
>
> Re-run states (`decide`): with the `v` tag already at `<sha>` and the adk tag
> absent, the run is a TAG with the `v` step marked SKIP ((n)); with BOTH tags at
> `<sha>` it is a SKIP, so no write job starts on later runs ((o)). Once `v` is
> known to sit at the sha, EVERY later refusal carries `v_verdict=SKIP`, so the
> refusal issue never prints `v: REFUSE` for an existing ref — fed from `decide`'s
> outputs when `write` was skipped — and that is asserted on the RENDERED issue
> line, not the wiring (`test/unit/release-auto-tag-workflow.test.ts`). The App
> must be listed as a bypass actor on the `adk-flair-v*` tag ruleset (id 24044018)
> for that second POST to be allowed. Each guarantee names its test:
> `test/unit/release-auto-tag.test.ts` and
> `test/unit/release-auto-tag-workflow.test.ts`.

The tag push triggers the [`release-publish`](../.github/workflows/release-publish.yml)
workflow, which:

1. Resolves the version from the tag and validates it as semver.
2. Verifies the tagged commit is an ancestor of `main` (a tag can't ship un-merged code).
3. Verifies every lockstep package's `package.json` is at that version.
4. Builds every package.
5. Runs `npm stage publish` for each lockstep package in dependency order
   (flair-client first). Any lockstep package
   failing to stage fails the release.

It authenticates via OIDC — no secrets, and it does **not** create or move any tag (the
tag is the trigger). Watch the run; when it's green, the packages are staged
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

### Phase 4 — the post-publish canary

Once [the promote boundary](#the-promote-boundary-flair1928) is in place (the tag
rulesets and the `release-promote` environment with its `NPM_TOKEN`), this phase runs
for you. The unprivileged
[`release-promote-poll`](../.github/workflows/release-promote-poll.yml) poll requires
a valid `release-attempt` marker, public tarballs for every lockstep package matching
the certified package-set digest, no visible non-dry-run attempt for the version, and
passing [settings checks](#the-promote-boundary-flair1928) before dispatching the privileged
[`release-promote`](../.github/workflows/release-promote.yml) workflow on the version's
tag ref, and that workflow calls the
[`post-publish canary`](../.github/workflows/canary.yml) — the same one below; its
definition resolves at the tag and its workspace runs the default branch's scripts at a
pinned commit — before it promotes anything. The poll ignores dry runs and dispatches
each version at most once per poll. A visible non-dry-run attempt prevents redispatch;
a failed attempt logs that a human must inspect it. Re-running it is an operator step
(replace `v1.2.3` with the release tag):

```bash
gh workflow run release-promote.yml --ref v1.2.3 -f dry_run=false
```

To run the canary alone by hand (it moves nothing), dispatch it with three inputs:

| Input | Value |
| ----- | ----- |
| `version` | the public version, exact (e.g. `vX.Y.Z` without the `v`) |
| `expected_sha256` | the published tarball's sha256 (64 hex). The canary computes it from the registry with `node scripts/ci/registry-tarball-sha256.mjs <ver>`. |
| `package_set_digest` | the certified package-set digest (64 lowercase hex), printed as `package-set-digest=<digest>` in the log of the release run's "Pack publishable packages and write the release manifest" step. It can also be recomputed from that step's lines (`<name>@<version>  <sha256>  <basename>`) by feeding `<name>=<sha256>` lines to `node scripts/ci/package-set-digest.mjs --version <ver>`. The canary re-derives the digest from the tarballs it verified and refuses a mismatch before any verdict. |

For example, after all staged packages are public: `gh workflow run canary.yml --ref main -f 'version=<ver>' -f 'expected_sha256=<flair-tarball-sha256>' -f 'package_set_digest=<package-set-digest>'`.

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

The promote is **lockstep**: a successful promote moves every package the release
staged to the same version. npm has no atomic multi-package move, so the block moves
them one at a time (`@tpsdev-ai/flair` last) and stops at the first failure with
RESTORE lines. `flair` at `latest` 0.55.1 while `flair-client` / `flair-mcp` / the
plugins sit at 0.54.2 is exactly the mismatch `flair#1383` detects at runtime —
and 0.55.1's promote had to be assembled by hand, line by line, for this reason.

With the tag rulesets configured as above, a successful `release-promote` run with `dry_run=false` does this phase
too: it re-reads and validates the version (from the tag ref),
the tag's ancestry, the release-attempt marker (from the deployments API) and the
certified package-set digest (from the registry bytes), runs the canary above, and —
on PASS — runs the promote block below, which it obtains as executable text from
`scripts/ci/canary-verdict.sh` (`--emit bash`, the same block a human would paste). A
manual dispatch of `release-promote` defaults `dry_run` to `true`: it validates through
block generation and prints the block, but does not test the move (the block's
current-`latest` reads, refusals and moves run only under the token). Its title ends
with `(dry run)` and it does not suppress the poll's real promotion. The manual path
below stays as the fallback; a failed run's recovery is
[described below](#slice-2-flair1928--the-privileged-promote).

- **On PASS**, paste the complete block emitted by `scripts/ci/canary-verdict.sh`
  in **Canary verdict — emit the promote or deprecate command**, from a repo
  checkout on a machine logged into npm. Its package-set digest comparison and
  current-`latest` reads finish before any move. A preflight failure moves no tags.
  A failure after earlier moves can leave some tags moved. Re-runs repeat the
  digest comparison and pre-move reads; equal versions are allowed, newer versions
  are refused. The block attempts each move in order and stops on failure.

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

  The promote block runs this check itself, in its wait mode (`--await 120`, with
  each package's previous `latest`): it reads every `latest` from the registry's
  dist-tags endpoint, re-reads a package that is not yet at `<ver>` until it is or
  the wait ends, and exits 3 if every such package still reads its previous
  `latest` at the end. On exit 3, re-run the command the block prints before
  restoring anything. A run without `--await` reads the package document, which
  the public registry serves from its CDN and which can still show the previous
  `latest` for a short time after a move.
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

### The promote boundary (flair#1928)

GitHub resolves a dispatched workflow and its local reusable canary at the tag ref.
The boundary is these two repository settings. The default-branch poll checks the
properties listed below through the API. A failed settings check records a warning
and prevents dispatch; the poll fails when a ready version reaches the dispatch
(a poll with nothing ready still succeeds).

**1. The `v*` tag rulesets** (Settings → Rules → Rulesets). Both must stay **Active**:

- **`release-tags-create`** (id `24044017`): target tags, include `refs/tags/v*`, no
  exclusions, rule **Restrict creations**. Only its configured creation actors may create a `v*` tag:
  repository admins, plus the release-tag App only if the auto-tagger is to create tags.
- **`release-tags-immutable`** (id `23944797`): target tags, include `refs/tags/v*`
  and `refs/tags/adk-flair-v*`, no exclusions, rules **Restrict updates**,
  **Restrict deletions** and **Block force pushes**.

The poll checks both pinned tag rulesets are active, target tags, have no exclusions
and carry the expected rule types and patterns, and requires
`current_user_can_bypass=never` for its own token on the immutable ruleset.
Other actors' rule exceptions are not visible to the poll.
A ruleset recreated under a new id requires updated pins in `release-promote-poll.yml`.

**2. The GitHub `release-promote` environment** (Settings → Environments), created once
by a repository admin before the first automated promote:

- Environment name: **`release-promote`**.
- **Deployment branches and tags:** Selected branches and tags, with exactly one rule:
  the **tag** pattern **`v*`**. The secret is available only to runs on a `v*` tag.
- **Required reviewers:** optional. On the normal staged-release path, npm 2FA
  approval is the human action when no environment reviewers are configured.
  The poll checks no npm approval record. If reviewers are added, each promote
  waits for their approval after its canary.
- Secret: **`NPM_TOKEN`**, a granular npm access token with **read and write on the
  lockstep packages** (`node scripts/ci/lockstep-packages.mjs` prints the list), automation access, expiry ≤ 90 days with a rotation reminder. It needs exactly the scope to
  move a dist-tag on those packages.

Before adding `NPM_TOKEN`, audit the creation actors, other actors' rule exceptions,
and existing `v*` tags: every existing tag that carries a `release-promote.yml` must carry
a copy reviewed on main. Older tags that predate the workflow need nothing.

The checks inside `release-promote.yml` and `canary.yml` are **defence in depth**, not
the boundary. They compare the executed files with `origin/main`, run repository scripts
only from a pinned `origin/main` tree, and refuse on any unverifiable input. They fire
only for a tag whose copy of the workflow is the reviewed one.

Until the environment exists, the poll dispatches nothing; if it exists without its
`NPM_TOKEN`, the token step refuses with a named message and moves nothing. A manual
run of `release-promote` with `dry_run` left at its default (`true`) needs no token: it
validates through block generation without testing the move or suppressing automatic
promotion.

### GitHub `adk-flair-publish` environment

Repository admin: add the tag rule `v*` under Settings → Environments →
`adk-flair-publish` → Deployment branches and tags → Selected branches and tags.
Keep `adk-flair-v*` and the required reviewer. No tag-creation ruleset change is needed.

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

## Automated promote (flair#1928)

On the normal staged-release path, npm approval precedes promotion. Slice 1 landed
the four pieces the privileged promote job (slice 2) stands on; it holds no npm credential (the poll runs on the automatic
`GITHUB_TOKEN` with `actions: write`, `contents: read` and `deployments: read`).

- **The certified digest travels with the release attempt.** The `release-attempt`
  deployment marker carries a `payload` of `package_set_digest`, `manifest_sha256`
  and `version`, taken from the values `stage-publish` re-derived from the artifact
  it staged. It is written BEFORE anything is staged, so a missing or mismatched
  digest refuses the stage (nothing staged).
- **A machine surface for the promote block.** `scripts/ci/canary-verdict.sh
  --emit bash` prints ONLY the executable promote block — byte-identical to the
  text between the fences a human sees (one definition). A FAIL or a non-release
  version has no promote block: `--emit bash` exits 3 with one stderr line.
- **The unprivileged poll.** `release-promote-poll.yml` runs every 10 minutes
  (`schedule` only — there is no manual trigger, because `gh workflow run --ref <branch>` runs that branch's copy of the workflow, and a guard inside the file cannot bind it to main) and holds NO npm credential: no `environment`,
  no repo secret — it runs on the automatic `GITHUB_TOKEN` with `actions: write`,
  `contents: read` and `deployments: read`. It checks out ONLY the default branch
  at the run's own sha (never a tag's tree), and brings exactly what the package
  derivation reads (`scripts/ci`, the root `package.json` and
  `packages/*/package.json`); that derivation FAILS CLOSED — a non-zero exit or an
  empty list is an error exit that names the cause, never a silent "ready". It
  reads every `release-attempt` / `promoted` marker across ALL pages
  (`--paginate`, flattened), and for each pending marker takes the version from the
  MARKER PAYLOAD (never main's `package.json`, which moves on after a release;
  never the ref alone — the ref must equal `v<payload.version>` or the marker is
  refused). It requires EVERY lockstep package `<name>@<version>` to be public and
  to re-derive the certified package-set digest (ALL-form: one missing/odd package
  is NOT READY, exit 0, the package named). Dispatch also requires the workflow
  to exist, no visible non-dry-run attempt for the version, and passing settings checks.
  Every run is a schedule run of the default branch's copy of the file, so
  `github.sha` is always a main sha. **The poll's outputs are
  never an input to what gets promoted** — the privileged job re-derives everything
  it acts on. (`test/unit/release-promote-poll-workflow.test.ts`.)
- **Trust-root ownership.** `.github/CODEOWNERS` puts `/scripts/ci/canary-verdict.sh`,
  `/scripts/ci/package-set-digest.mjs`, `/scripts/ci/registry-tarball-sha256.mjs`,
  `/scripts/ci/registry-latest-skew.mjs`, `/scripts/ci/lockstep-packages.mjs`,
  `/.github/workflows/canary.yml` and `/.github/workflows/release-promote*.yml`
  under the trust root (`@heskew`); the test resolves EFFECTIVE ownership (last
  matching rule wins) for each protected path.
  (`test/unit/release-auto-tag-workflow.test.ts`.)

### Slice 2 (flair#1928) — the privileged promote

`release-promote.yml` (`workflow_dispatch` on the tag ref, `environment:
release-promote`) is the only job that can see `NPM_TOKEN`. It takes nothing from the
poll but "run now on this ref". The poll requires the
[settings checks](#the-promote-boundary-flair1928) to pass before dispatching;
the controls below are defence in depth
inside the workflow, each a test in `test/unit/release-promote-workflow.test.ts`:

- **No repository script from the tag's checkout** (defence in depth). GitHub runs the tag's copy of
  `release-promote.yml` and of the `canary.yml` it calls. `prepare` pins `origin/main`
  and moves its workspace there; the canary moves its workspace to that same commit
  before any repository script runs (its install, boot and plugin checks included), and
  if that move fails no later step runs a repository script: an inline step emits the
  FAIL verdict. The promote job materialises a SEPARATE tree from its own pinned
  `origin/main`. (The canary does run the PUBLISHED Flair and plugin packages it
  installs: that is its test.) The promote job's first act requires both workflow files
  and every executed repository script (the canary's script closure included) to be
  byte-identical between the tag and `origin/main`. `.github/CODEOWNERS` names the
  release trust root as their reviewer; that is enforced as far as the repository's
  rules require code-owner review.
- **Re-read and validated, fail-closed.** The version is `github.ref_name` matching
  `v<major>.<minor>.<patch>` exactly (a prerelease is refused); the tag commit is an
  ancestor of `origin/main`; the `release-attempt` marker exists with that version and a
  64-hex digest; and the registry package set re-derives to exactly that digest. An
  unmeasurable input is a refusal, never a pass.
- **Token hygiene.** `NPM_TOKEN` appears in ONE step's `env`, reaches npm only through a
  throwaway `.npmrc` indirection, and is never a command argument or echoed. npm is
  pinned to the canary's exact version (11.19.1), installed from a job directory and
  verified with `npm --version` before the registry reads and tag moves that follow;
  another version is a refusal.
- **Non-dry-run attempts; at most once per poll.** Across all run-list pages, the
  poll matches the title `release-promote v<version>`, without the `(dry run)` suffix.
  Queued, in-progress or successfully completed runs prevent dispatch. Other matching
  runs require human review without automatic redispatch. Within one poll it
  dispatches each version at most once, whatever the number of marker rows. A failed
  or uninterpretable run-list read is an error. This is a list-then-dispatch check,
  not a reservation.

**When the promote block fails.** Nothing is restored automatically (a restore cannot
be told apart from clobbering a newer legitimate `latest`); the job fails and the run
log carries the commands for a human:

- **Superseded or unreadable, before any move.** A package whose current `latest`
  cannot be read, or is already a NEWER version, stops the block before the first
  `dist-tag add`. Nothing moved.
- **A `dist-tag add` fails.** The block stops at that package, prints a RESTORE line for
  every package it attempted (the failed one included: npm can apply a tag and still
  exit non-zero) and lists the packages never attempted. The convergence check does not
  run on this path.
- **Every add succeeds, the convergence check does not.** Exit 1 (skew) or 2 (the
  check could not read the state) prints the same RESTORE lines; exit 3 (the registry
  still served a previous `latest` when the wait ended) prints the check's re-run command
  first and the RESTORE lines as the fallback.

**Re-running the same version's promote.** The block re-derives the certified digest
and permits equal versions. A newer `latest` at the pre-move read stops the run
before any move. Not covered: two
versions' promotes running at the same moment, or a move made by hand between the
block's read and its moves; the read precedes the moves, it is not a lock.
