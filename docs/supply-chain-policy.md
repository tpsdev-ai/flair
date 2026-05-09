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

### 2. Exact-version pinning for production deps

Every `dependencies` entry in any `package.json` must be a single concrete version (`"5.0.9"`), not a range (`"^5.0"`, `"~5.0.9"`, `">=5"`). Range specifiers expose us to silent supply-chain swaps every install — exactly the surface attackers exploit.

- `devDependencies` and `peerDependencies` may use ranges (they don't ship in our published tarballs).
- `bun.lock` is committed and frozen-lockfile installed in CI. Any unintended dep drift fails the workspace-deps consistency gate.
- Pin updates happen via deliberate PRs, not automated bumps. Renovate / Dependabot are not enabled.

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

- Rockit is not logged into npm by design.
- The post-publish smoke verification (filed as `ops-wbe9`) will once-add an automated round-trip check after each publish to ensure cross-package resolution works on the actually-published artifacts.

---

## Automation

### `scripts/check-workspace-deps.mjs` (already shipped, PR #368)

Fails any PR where a workspace package declares an internal `@tpsdev-ai/*` dep at a version other than what that workspace package ships. Wired into the `test-unit` job.

### `scripts/check-dep-ages.mjs` (this PR)

Fails any PR with an external pinned production dep version published less than `FLAIR_DEP_MIN_AGE_DAYS` ago (default 7). Queries the npm registry's `time` map. Workspace-internal deps exempt. Wired into the `test-unit` job.

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

---

## Adopting this policy in a downstream project

If you're building on top of `@tpsdev-ai/flair-client` and want the same posture:

```bash
# Copy the dep-age guard into your repo
curl -fsSL https://raw.githubusercontent.com/tpsdev-ai/flair/main/scripts/check-dep-ages.mjs \
  -o scripts/check-dep-ages.mjs
chmod +x scripts/check-dep-ages.mjs

# Wire it into your CI as a fast pre-test step
- run: node scripts/check-dep-ages.mjs
```

The script has no external dependencies — node 18+ is enough.

---

## Exceptions and incident response

- **Bypass for known-good fresh dep:** set `FLAIR_DEP_MIN_AGE_DAYS=0` for the affected CI run AND open a PR to add a comment-row in this doc explaining the exception. Don't bypass silently.
- **Confirmed upstream compromise affecting Flair:** rotate any affected credential, revert the offending dep version, ship a patch release, file a public advisory at `github.com/tpsdev-ai/flair/security/advisories`. Notify Nathan immediately; don't act unilaterally.
- **Suspected (not confirmed) compromise:** open an issue with the evidence; treat it as P0 in our backlog until disproven.

---

## See also

- `notes/dogfood-log.md` — internal incidents that have shaped this policy
- `scripts/check-workspace-deps.mjs` — the workspace-internal dep consistency gate
- `scripts/check-dep-ages.mjs` — the bake-time dep guard
- `ops/scripts/git-hooks/pre-commit-secret-guard.sh` — pre-commit secret blocker
