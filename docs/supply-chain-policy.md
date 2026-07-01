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

Some deps are tightly coupled to Flair's runtime correctness — Harper bug fixes and security patches land in `@harperfast/harper`, embedding-pipeline fixes land in `harper-fabric-embeddings`. We accept the bake-time risk and pull these eagerly. Current allow-list:

| Package | Why kept current |
|---------|------------------|
| `@harperfast/harper` | Foundational. Vector-index and HNSW correctness fixes land here; we want them ASAP. High-volume upstream, fast detection if compromised. |
| `harper-fabric-embeddings` | Embedding model loader. Coupled to Harper version. Same trust-and-volume reasoning. |
| `@harperfast/oauth` | Same high-trust `@harperfast/*` owner as `@harperfast/harper`. Used ONLY by the **default-OFF** native-MCP OAuth surface (`FLAIR_MCP_OAUTH`), which dynamically imports it only when the flag is on — it is **not loaded in the shipped default build**, so bake-time exposure is zero until an operator explicitly opts in. Pinned to the exact version whose `withMCPAuth` API the surface was built against; the API surface (not a floating range) is what we depend on. |

Adding to this list is a deliberate decision. The bar:
- The upstream is well-known and high-volume (gets eyeballs fast).
- We have a direct reason to want patches as soon as published (a known bug we're tracking, a security patch we need, or correctness coupling).
- We accept that a freshly-malicious version could land in our build before broader detection.

Document any addition here, in this section, alongside the package name. The doc is the audit trail.

Override per-run via `FLAIR_DEP_KEEP_CURRENT="pkg1,pkg2,@scope/pkg3"` env (additive — adds to the default allow-list, doesn't replace it).

### 2. Exact-version pinning for production deps

Every `dependencies` entry in any `package.json` must be a single concrete version (`"5.0.9"`), not a range (`"^5.0"`, `"~5.0.9"`, `">=5"`). Range specifiers expose us to silent supply-chain swaps every install — exactly the surface attackers exploit.

- `peerDependencies` may use ranges (host-provided; never installed by us). `devDependencies` are also exact-pinned for build reproducibility, though they don't ship in our published tarballs.
- `bun.lock` is committed and frozen-lockfile installed in CI. Any unintended dep drift fails the workspace-deps consistency gate.
- Pin updates happen via deliberate, test-gated PRs — never auto-merged. **Renovate is enabled** (`.github/renovate.json`) to *propose* these updates on a schedule, but it respects the bake-time cooldown (`minimumReleaseAge: "7 days"`, matching `FLAIR_DEP_MIN_AGE_DAYS`) and opens PRs only — `automerge` is off, so every bump flows through the full test suite + K&S review. Renovate uses `rangeStrategy: "pin"` so it proposes exact-version bumps (never re-widens to ranges) and shares the keep-current allow-list with `check-dep-ages.mjs`. Vulnerability alerts bypass the cooldown so security fixes aren't delayed.

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

---

## Automation

### `.github/renovate.json` — deliberate, cooldown-gated update proposals

Renovate opens PRs to propose dependency updates so we don't drift behind upstream indefinitely — but on our terms, not the registry's. It is configured to never auto-merge (`automerge: false`), to pin (`rangeStrategy: "pin"`, consistent with §2), and to respect the bake-time cooldown (`minimumReleaseAge: "7 days"`, matching `FLAIR_DEP_MIN_AGE_DAYS` in `check-dep-ages.mjs`) so it only proposes versions that have already cleared the detection window. Non-major updates are grouped; majors land as isolated PRs. The keep-current allow-list (`@harperfast/harper`, `harper-fabric-embeddings`, `@harperfast/oauth`) mirrors the script's `DEFAULT_KEEP_CURRENT` — keep the two in lockstep when either changes. Vulnerability alerts bypass the cooldown. Every Renovate PR still runs the full CI suite (including the bake-time and workspace-deps gates) and is K&S-reviewed before merge.

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

### Flair pre-commit hook (`scripts/git-hooks/`)

Mirrors the CI test-unit gates locally so issues are caught at `git commit` time, not after the runner round-trip:

```bash
./scripts/git-hooks/install.sh
```

Runs three checks before each commit:
- `check-workspace-deps.mjs` — workspace internal-dep version lockstep
- `check-dep-ages.mjs` — supply-chain bake-time (≥7 days for external pinned deps)
- `check-impl-term-leaks.sh` — no Bead refs / impl labels in user-facing docs

Each check matches a CI gate exactly so the local and remote outcomes can't drift. Bypass with `git commit --no-verify` when warranted (rare; CI will still catch you). Skip just the dep-ages check (the slowest one, ~2-5s of registry fetches) with `FLAIR_PRECOMMIT_SKIP_DEP_AGES=1 git commit`.

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
- `ops/scripts/git-hooks/pre-commit-secret-guard.sh` — pre-commit secret blocker (cross-repo)
- `scripts/git-hooks/pre-commit` + `scripts/git-hooks/install.sh` — flair-specific pre-commit (mirrors test-unit CI gates)
