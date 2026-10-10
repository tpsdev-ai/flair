# Flair supply-chain policy

How we keep Flair's published packages safe from upstream supply-chain attacks. This document describes both our policies and the automation that enforces them.

> **Why this exists.** Mini Shai-Hulud worm attack (Apr 30 2026, Intercom npm + Composer PHP). Sleeper malicious Ruby gems and Go modules (May 1). NuGet typosquats with crypto-wallet stealers (May 6). The window between "package compromised" and "compromise widely flagged" is the entire risk surface, and it's been hours-to-days, not weeks. As Flair adds integration adapters across more ecosystems, our exposure grows; this is the policy + automation that bounds it.

---

## Policies

### 1. Bake-time policy: 7 days minimum for new dep versions

We don't pull in any newly-published dep version for **at least 7 days** after its publish date.

- The most-attacked window is "compromise published, defenders haven't yet noticed." Most malicious packages get flagged by Socket.dev, npm advisory, GitHub security advisory, or human reports within 1-7 days. Our delay puts us behind that detection front.
- pnpm 11 shipped this as a default at 1 day (May 4 2026). We chose 7 as a more conservative posture for a security-adjacent project.
- Workspace-internal `@tpsdev-ai/*` deps are exempt. We publish ourselves; we have direct visibility into our own changes; our 0.8.0 → 0.8.1 patch turnaround was same-day and we want to keep that latitude.
- Tunable via `FLAIR_DEP_MIN_AGE_DAYS` env var if a specific run needs a different threshold. Don't bypass; document the exception.

#### 1a. Keep-current allow-list

Some deps are tightly coupled to Flair's runtime correctness — Harper bug fixes and security patches land in `harper`, embedding-pipeline fixes land in `harper-fabric-embeddings`. We accept the bake-time risk and pull these eagerly. Current allow-list:

| Package | Why kept current |
|---------|------------------|
| `harper` | Foundational. Vector-index and HNSW correctness fixes land here; we want them ASAP. High-volume upstream, fast detection if compromised. **Bare name, not `@harperfast/harper`** — the two are permanent lockstep publishes of the same source, and depending on the scoped one made every install materialise both copies (~213 MB), because `@harperfast/oauth` peers on the bare name and npm cannot dedupe across two names. Aligned in flair#870. |
| `harper-fabric-embeddings` | Embedding model loader. Coupled to Harper version. Same trust-and-volume reasoning. |
| `@harperfast/oauth` | Same high-trust upstream owner as `harper`. Used ONLY by the **default-OFF** native-MCP OAuth surface (`FLAIR_MCP_OAUTH`), which dynamically imports it only when the flag is on — it is **not loaded in the shipped default build**, so bake-time exposure is zero until an operator explicitly opts in. Pinned to the exact version whose `withMCPAuth` API the surface was built against; the API surface (not a floating range) is what we depend on. |

Adding to this list is a deliberate decision. The bar:
- The upstream is well-known and high-volume (gets eyeballs fast).
- We have a direct reason to want patches as soon as published (a known bug we're tracking, a security patch we need, or correctness coupling).
- We accept that a freshly-malicious version could land in our build before broader detection.

Document any addition here, in this section, alongside the package name. The doc is the audit trail.

Override per-run via `FLAIR_DEP_KEEP_CURRENT="pkg1,pkg2,@scope/pkg3"` env (additive — adds to the default allow-list, doesn't replace it).

#### 1b. Dated exemptions for security pins

A security patch can be newer than the bake window, and pinning it is the right move. The gate accepts an explicit, dated exemption in `.github/dep-age-allowlist.json`: one entry per checked exact-pinned `package` and `version` (in `dependencies`, `optionalDependencies` or `overrides`), with a GHSA-formatted id (`ghsa`), `added`, `expires` and a `reason`. Review verifies that the version fixes the advisory.

- An entry exempts an otherwise checked pin only while unexpired; `expires` is the first day it no longer applies.
- An **expired** entry fails the gate before any registry request; removing it lets an otherwise checked pin be age-checked. Re-read the `reason` before re-dating; removing the entry once the version has aged past the window is the normal outcome.
- A fresh checked pin with no matching entry fails; keep-current pins are skipped. A malformed entry also fails.

`FLAIR_DEP_MIN_AGE_DAYS` remains a threshold control: it moves the bar for every checked pin at once and leaves no record. A per-pin exemption belongs in this allowlist.

### 2. Exact-version pinning for production deps

Some `dependencies` entries are exact-pinned (`harper@5.3.1`, `commander@14.0.3`, `jose@6.2.2`, `tweetnacl@1.0.3`), but others are range-spec'd (`harper-fabric-embeddings@^0.5.0`, `js-yaml@^4.3.2`, `semver@^7.8.5`, `tar@^7.5.22`). Overrides are mostly ranges (`^`/`~`). The age gate (`scripts/check-dep-ages.mjs`, with the collection rule in `collectDeps` in `scripts/lib/check-dep-ages-collect.mjs`) checks npm publish age for non-exempt external exact pins in `dependencies`, `optionalDependencies` and `overrides` — root and every workspace package.json. In `dependencies` and `optionalDependencies` a specifier is classified by the same version classifier the override grammar uses: an exact version is age-checked, a range such as `1.x` or `^1` is not; in `overrides`, nested rules included, it is an exact declaration, and an `npm:` alias is checked against its target. Workspace-internal dependencies, the keep-current list (`harper`, `harper-fabric-embeddings`, `@harperfast/oauth`) and exact pins with a matching unexpired exemption in `.github/dep-age-allowlist.json` (§1b) are exempt; the default threshold is seven days. The gate reads manifests, not the lockfile: an exact version is age-checked, a range is printed as not age-checked, and a refused dependency or override form fails the gate.

- `peerDependencies` may use ranges: they state what the host project must provide. They are still installed, but an exact-pin check of our declaration does not describe what actually gets installed — the consumer resolves them from a range. This is the reason we do not include peers in the bake-time gate (not "never bundled into tarballs"): the gate checks versions we actually pull, and we don't pull a peer declaration at face value. Our workspace install records the required peers of `langgraph-flair`, `n8n-nodes-flair` and `openclaw-flair` in `bun.lock` like any other dependency (the frozen-lockfile install does not check a recorded peer against its declared range; flair#1936). Most `devDependencies` are exact-pinned for build reproducibility; a few are ranged (`@types/semver@^7.8.0`). They don't ship in our published tarballs.
- **Flair declares no optional peers today**, and no `optionalDependencies` at the root; `packages/flair-bench/package.json` (line 38) declares some. If either is ever proposed as an install-weight fix, the mechanism has now been measured twice (`@harperfast/oauth` flair#750, `node-llama-cpp` flair#887) and the result is counter-intuitive enough to be worth stating: **only `peerDependencies` + `peerDependenciesMeta.optional` is skipped by a default install** (npm and bun alike). A plain `optionalDependencies` entry *is* still installed by default — "optional" there means "a failed install is non-fatal", not "skipped" — so it buys no install-weight reduction whatsoever. Exact-pinning an optional peer (rather than ranging it) is also legitimate where the consuming code path is version-sensitive, so that an operator who installs a different version gets told the version they have is not the version that was tested.

  Note the corollary, measured during flair#893: an optional peer that is simply *absent* installs silently — npm prints no warning at all — so it cannot be relied on to prompt anyone to install it. Anything a user must install for a feature to work needs to be documented, or detected and reported at runtime.
- `bun.lock` is committed and `bun install --frozen-lockfile` is run in CI (`.github/workflows/test.yml`, ~121). That lockfile gate fails when package.json and bun.lock disagree; `scripts/check-workspace-deps.mjs` compares each recognized internal `@tpsdev-ai/*` dependency's literal declared version to the version the target package ships, and accepts `workspace:` declarations (e.g. `workspace:*` at `packages/cursor-wake-runner/package.json`, line 22; skip at `scripts/check-workspace-deps.mjs`, line 59).
- Pin updates happen via deliberate, test-gated PRs — never auto-merged. **Renovate is enabled** (the shared org preset at `.github/renovate-preset.json`, with `.github/renovate.json` holding only flair-specific exceptions) to *propose* these updates on a schedule, but it respects the bake-time cooldown (`minimumReleaseAge: "7 days"`, matching `FLAIR_DEP_MIN_AGE_DAYS`) and opens PRs only — `automerge` is off, so every bump flows through the full test suite + K&S review. Renovate uses `rangeStrategy: "pin"` so it proposes exact-version bumps (never re-widens to ranges) and shares the keep-current allow-list with `check-dep-ages.mjs`. Vulnerability alerts bypass the Renovate cooldown, so Renovate can propose an advisory fix immediately; the CI age gate can still hold a fresh pinned npm production dependency.

### 3. Internal dep version lockstep

Every `@tpsdev-ai/*` dep declared in any workspace package must match the version that workspace package ships. Enforced by `scripts/check-workspace-deps.mjs` in the test-unit CI job.

- Why: prevents the v0.8.0 bug shape where `openclaw-flair@0.8.0` declared `@tpsdev-ai/flair-client@0.5.0`, shipping a 3-version-old client to consumers of the published tarball.
- See `notes/dogfood-log.md` for the full incident.

### 4. Workspace `bun.lock` is the source of truth

Direct `bun.lock` regenerations (e.g. `rm bun.lock && bun install`) are discouraged. They can rewrite git URLs to use ssh-protocol resolution that breaks Docker builds (the libsignal incident on PR #368) and reset other resolution choices.

- Instead: use `bun install` with the existing lockfile, or surgical edits for known bug fixes.
- All lockfile changes are reviewed; any cross-protocol or cross-version churn beyond the stated scope of the PR is a red flag.

### 5. Socket.dev CI job is mandatory

Every PR runs the Socket.dev Supply Chain check. Failure blocks merge. The Socket scan complements the bake-time policy — Socket catches *known* compromises; the 7-day delay catches *not-yet-known* ones.

### 6. Publish surface

Only Nathan publishes to npm (per the existing MFA boundary). Flint preps the release commit + version bump + CHANGELOG; Nathan runs `./scripts/release.sh <ver> --publish` from his laptop.

- The build host is not logged into npm by design.
- A planned post-publish smoke job will add an automated round-trip check after each publish to ensure cross-package resolution works on the actually-published artifacts.

### 7. Dependency audit gate: blocking, with dated exceptions

`bun audit` runs on every PR via the `audit` job and **blocks merge**. Every advisory it reports must either be fixed or appear in `.github/audit-allowlist.json`. There is no third option and no global escape hatch.

This replaced a step that could not fail:

```yaml
run: bun audit || echo "::warning::Audit found vulnerabilities — all in harper transitive deps (unreleased v5 build)"
continue-on-error: true
```

Both mechanisms independently forced a pass (`|| echo` made the shell exit 0, so `continue-on-error` was dead config that never even fired). The justification was accurate the day it was written. It carried **no expiry**, so it outlived its reason — by the time it was removed, "all in harper transitive deps" was false, and a critical advisory was reaching users through a first-party workspace package while the gate reported green.

**The defect was the unexpirable exception, not the exception.** Some advisories genuinely cannot be fixed from this repo. So each one is now enumerated with:

| field | meaning |
|---|---|
| `ghsa` | the published advisory id |
| `package`, `severity` | re-verified against `bun audit` on every run; drift fails the gate |
| `class` | `no-patch-published`, `vendor-pinned`, or `remediation-available` |
| `introducedBy` | the dependency edge that pulls it in |
| `reason` | why it cannot be fixed here, specifically |
| `added`, `expires` | hard dates; lifetime is capped by severity |
| `removeWhen` | the concrete condition that retires the entry |

`scripts/audit-gate.mjs` fails the build on: an unlisted advisory, a malformed entry, an entry parked beyond its severity cap (critical 30 days, high 60, moderate/low 180), an **expired** entry, a **stale** entry whose advisory no longer appears, or a `no-patch-published` entry for which a patched version has since shipped. That last pair matters — an allowlist that only ever grows is the same failure with more ceremony.

When an entry expires the build fails and a human re-decides. **That is the mechanism working, not a flaw.** Re-dating an entry without re-reading its reason is how this file rots back into the thing it replaced.

Run it locally with `node scripts/audit-gate.mjs --explain`.

**Standing rule for every check in this repo:** any check that is advisory-only must carry, in a comment at its own definition, what would make it blocking and when that gets re-evaluated. Advisory is a terminating state with a defined promotion event, never a resting place.

---

## Automation

### The shared org preset — `.github/renovate-preset.json` (`.github/renovate.json` holds only flair-specific exceptions)

Renovate opens PRs to propose dependency updates so we don't drift behind upstream indefinitely — but on our terms, not the registry's. The org preset (`.github/renovate-preset.json`) is common to all tpsdev-ai repos; `.github/renovate.json` holds only flair-specific overrides (workspace-internal dep exclusions, keep-current allow-list)

Renovate is configured to never auto-merge (`automerge: false`), to pin (`rangeStrategy: "pin"`, consistent with §2), and to respect the bake-time cooldown (`minimumReleaseAge: "7 days"` by default, matching `FLAIR_DEP_MIN_AGE_DAYS` in `check-dep-ages.mjs`), so by default it proposes only versions that have cleared the detection window — the two named exceptions are vulnerability fixes and the keep-current list below. Non-major updates are grouped per ecosystem (npm/Bun, Python, GitHub Actions, Docker); a manager outside those four gets no ecosystem-wide group from the four explicit rules (groups inherited from config:recommended may still apply); majors land as isolated PRs. The keep-current allow-list (`harper`, `harper-fabric-embeddings`, `@harperfast/oauth`) mirrors the script's `DEFAULT_KEEP_CURRENT` — keep the two in lockstep when either changes. Vulnerability alerts bypass the cooldown: Renovate can propose an advisory fix immediately. Flair's CI age gate (`check-dep-ages.mjs`) can still block a fresh pinned npm production dependency; other fresh versions follow the 7-day cooldown unless an explicit exception, such as the keep-current list, applies. The control for the fast-track is not the cooldown: it is `automerge: false` plus the full CI suite (including the bake-time and workspace-deps gates) and a K&S review on every Renovate PR. Docker image digests in Dockerfiles and compose files land in the docker group; images in workflow `container:`/`services:` are proposed by the github-actions manager and land in the github-actions group. The preset is in the CODEOWNERS trust root (`@heskew`): Renovate reads it from the default branch for every repo that extends it, so a change to it takes the same human as a change to the release tagger.

### `scripts/check-workspace-deps.mjs` (already shipped, PR #368)

Fails any PR where a workspace package declares an internal `@tpsdev-ai/*` dep at a version other than what that workspace package ships. Wired into the `test-unit` job.

### `scripts/check-dep-ages.mjs` (this PR)

Fails when a checked external exact-pinned production dep version was published less than `FLAIR_DEP_MIN_AGE_DAYS` ago (default 7) without a matching unexpired exemption; keep-current pins are skipped. Queries the npm registry's `time` map. Checks `dependencies`, `optionalDependencies` and `overrides` (root and every workspace package.json) — npm and bun install optionalDependencies by default; the gate checks exact override declarations, including conditional rules, not installed versions. Workspace-internal deps and exact pins with a matching unexpired exemption in `.github/dep-age-allowlist.json` (§1b) are exempt; a range is printed, not age-checked, and a refused dependency or override form fails the gate. Wired into the `test-unit` job. Its limits, stated: it does not check `peerDependencies` (resolved from a range by the consumer's install) nor `devDependencies` (don't ship in our tarballs) — it reads the same registry publish timestamp Renovate does, so it is a second line against the cooldown being removed from the config — not against a release whose publish date lies.

Configurable:

```bash
# Run with a different threshold:
FLAIR_DEP_MIN_AGE_DAYS=14 node scripts/check-dep-ages.mjs

# Run against a private registry:
FLAIR_NPM_REGISTRY=https://my-registry.example/ node scripts/check-dep-ages.mjs
```

### Pre-commit secret-guard hook (already shipped, `ops/scripts/git-hooks/`)

Blocks at stage time:
- Secret-shaped filenames (`.pem`, `.key`, `.env*`, `*api-key*`, `*pat*`, `*secret*`, etc.)
- Embedded git clones added without a `.gitmodules` entry
- Any single staged file >2MB

Available in `ops/scripts/git-hooks/install.sh`. Required for any agent or operator with commit access.

### Flair pre-commit hook (`scripts/git-hooks/`)

Mirrors the CI test-unit gates locally so issues are caught at `git commit` time, not after the runner round-trip:

```bash
./scripts/git-hooks/install.sh
```

Runs three checks before each commit:
- `check-workspace-deps.mjs` — workspace internal-dep version lockstep
- `check-dep-ages.mjs` — supply-chain bake-time (≥7 days for external pinned deps)
- `check-impl-term-leaks.sh` — no Bead refs / impl labels in user-facing docs, `CHANGELOG.md`, or `.changelog/`

Each check matches a CI gate exactly so the local and remote outcomes can't drift. Bypass with `git commit --no-verify` when warranted (rare; CI will still catch you). Skip just the dep-ages check (the slowest one, ~2-5s of registry fetches) with `FLAIR_PRECOMMIT_SKIP_DEP_AGES=1 git commit`.

---

## Adopting this policy in a downstream project

If you're building on top of `@tpsdev-ai/flair-client` and want the same posture:

The guard is two files: `scripts/check-dep-ages.mjs` imports `./lib/check-dep-ages-collect.mjs` relative to itself, so copy both and keep `lib/` beside the script.

```bash
# Copy the dep-age guard into your repo (both files, same relative layout)
mkdir -p scripts/lib
curl -fsSL https://raw.githubusercontent.com/tpsdev-ai/flair/main/scripts/check-dep-ages.mjs \
  -o scripts/check-dep-ages.mjs
curl -fsSL https://raw.githubusercontent.com/tpsdev-ai/flair/main/scripts/lib/check-dep-ages-collect.mjs \
  -o scripts/lib/check-dep-ages-collect.mjs
chmod +x scripts/check-dep-ages.mjs

# Wire it into your CI as a fast pre-test step
- run: node scripts/check-dep-ages.mjs
```

The two files have no external dependencies — node 18+ is enough.

To adopt the same Renovate preset in your repo, make your `.github/renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>tpsdev-ai/flair//.github/renovate-preset"]
}
```

Add `packageRules` only for your own exceptions. The preset carries no `@tpsdev-ai/**` exclusion: a repo whose own release process bumps tpsdev-ai workspace packages adds the same `{ "matchPackageNames": ["@tpsdev-ai/**"], "enabled": false }` rule flair keeps in `.github/renovate.json`, otherwise their non-major updates join the non-major npm group (major updates stay isolated, like every other major).

---

## Exceptions and incident response

- **Exempt an otherwise checked fresh security pin:** add a dated entry to `.github/dep-age-allowlist.json` naming the advisory (§1b). It is reviewed on the PR and expires on its own. Don't bypass silently.
- **Confirmed upstream compromise affecting Flair:** rotate any affected credential, revert the offending dep version, ship a patch release, file a public advisory at `github.com/tpsdev-ai/flair/security/advisories`. Notify Nathan immediately; don't act unilaterally.
- **Suspected (not confirmed) compromise:** open an issue with the evidence; treat it as P0 in our backlog until disproven.

---

## See also

- `notes/dogfood-log.md` — internal incidents that have shaped this policy
- `scripts/check-workspace-deps.mjs` — the workspace-internal dep consistency gate
- `scripts/check-dep-ages.mjs` — the bake-time dep guard
- `ops/scripts/git-hooks/pre-commit-secret-guard.sh` — pre-commit secret blocker (cross-repo)
- `scripts/git-hooks/pre-commit` + `scripts/git-hooks/install.sh` — flair-specific pre-commit (mirrors test-unit CI gates)
