#!/usr/bin/env bash
set -euo pipefail

# release.sh — Bump all workspace packages to a single version and publish.
#
# Two-phase flow (respects main branch protection — no direct pushes, no bypass):
#
#   Phase 1 — open release PR:
#     ./scripts/release.sh 0.5.0
#       → creates branch release/v0.5.0, assembles the .changelog/unreleased/
#         fragments into a `## [0.5.0]` CHANGELOG section, bumps + builds +
#         tests, commits, pushes, opens PR. Review and merge via GitHub.
#
#   Phase 2 — tag after merge (normal path; see docs/releasing.md):
#     git tag v0.5.0 && git push origin v0.5.0
#       → CI stages every package via OIDC. No npm credential on any machine.
#
#   Break-glass only (CI staging unavailable):
#     ./scripts/release.sh 0.5.0 --publish
#     ./scripts/release.sh 0.5.0 --publish --break-glass
#       → publishes from THIS machine. Requires an explicit acknowledgement
#         (type BREAK-GLASS, or pass --break-glass with --publish). Who can
#         publish is unchanged; this only marks the path. --break-glass is
#         not a mode — alone it fails closed instead of entering Phase 1.
#
#   ./scripts/release.sh 0.5.0 --dry
#       → phase-1 bump + build + test on a local branch, skip push/PR.

VERSION="${1:?Usage: release.sh <version> [--publish [--break-glass]|--dry]}"
shift
MODE=""
ACK=""
for arg in "$@"; do
  case "$arg" in
    --publish|--dry)
      if [[ -n "$MODE" && "$MODE" != "$arg" ]]; then
        echo "❌ Conflicting flags: $MODE and $arg"
        echo "   Usage: release.sh <version> [--publish [--break-glass]|--dry]"
        exit 1
      fi
      MODE="$arg"
      ;;
    --break-glass)
      ACK="--break-glass"
      ;;
    *)
      echo "❌ Unknown argument: $arg"
      echo "   Usage: release.sh <version> [--publish [--break-glass]|--dry]"
      exit 1
      ;;
  esac
done
if [[ "$ACK" == "--break-glass" && "$MODE" != "--publish" ]]; then
  echo "❌ --break-glass is an acknowledgement for --publish, not a mode."
  echo "   Use: ./scripts/release.sh ${VERSION} --publish --break-glass"
  echo "   The normal release is: git tag v${VERSION} && git push origin v${VERSION}"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# VERSION is interpolated into node -e heredocs and git/gh commands below.
# Anchored semver-ish pattern: digits, dots, optional pre-release (-rc.1,
# -alpha, etc.). Rejects quotes, backticks, semicolons — nothing that could
# break out of the string literal in `pkg.version = '$VERSION';`.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "❌ Invalid version: '$VERSION'. Expected semver (e.g. 0.5.6 or 1.0.0-rc.1)."
  exit 1
fi

PACKAGES=(
  "$ROOT/packages/flair-client"
  "$ROOT/packages/flair-mcp"
  "$ROOT/packages/openclaw-flair"
  "$ROOT/packages/pi-flair"
  "$ROOT/packages/n8n-nodes-flair"
  "$ROOT/packages/langgraph-flair"
  "$ROOT/packages/adk-flair-js"
  "$ROOT/packages/flair-bench"
  "$ROOT"
)

PACKAGE_JSONS=(
  "$ROOT/packages/flair-client/package.json"
  "$ROOT/packages/flair-mcp/package.json"
  "$ROOT/packages/openclaw-flair/package.json"
  "$ROOT/packages/pi-flair/package.json"
  "$ROOT/packages/n8n-nodes-flair/package.json"
  "$ROOT/packages/langgraph-flair/package.json"
  "$ROOT/packages/adk-flair-js/package.json"
  "$ROOT/packages/flair-bench/package.json"
  "$ROOT/package.json"
)

# Prefer gh-as flint (tpsdev-ai org access) per CLAUDE.md
if command -v gh-as >/dev/null 2>&1; then
  GH="gh-as flint"
else
  GH="gh"
fi

# Authenticated push helper.
#
# Plain `git push origin` fails auth on hosts without a working cred helper for
# the flair remote (rockit: "Password authentication is not supported"). Push
# with the gh token supplied through a per-invocation credential helper. The
# token is read once here and NEVER echoed/printed, and it is never placed in
# a URL or any other argv position (flair#955): an embedded-token URL is visible
# to `ps`, to `set -x`, to CI step logs and to any transcript that captured the
# command line, and each of those has burned a rotation before.
TOK="$($GH auth token 2>/dev/null || gh auth token 2>/dev/null || true)"
git_push_auth() {
  # Usage: git_push_auth <refspec> [<refspec>...]
  if [[ -z "${TOK:-}" ]]; then
    echo "❌ No GitHub token available (tried '$GH auth token' and 'gh auth token')." >&2
    echo "   Authenticate first (e.g. 'gh auth login') so release pushes can authenticate." >&2
    return 1
  fi
  # The token must never appear in argv (ps, shell traces, CI logs, transcripts —
  # flair#955). Hand it to git through a one-shot credential helper that reads
  # it from the environment at call time: the single-quoted helper string is
  # literal in argv, and only the helper's own shell expands $GH_PUSH_TOKEN.
  # Subshell with tracing off: under `set -x` even an env-prefix assignment
  # prints its value, so the export happens where the trace cannot see it.
  (
    set +x
    export GH_PUSH_TOKEN="$TOK"
    exec git -C "$ROOT" \
      -c credential.helper= \
      -c 'credential.helper=!f() { echo "username=x-access-token"; echo "password=${GH_PUSH_TOKEN}"; }; f' \
      push "https://github.com/tpsdev-ai/flair.git" "$@"
  )
}

# -----------------------------------------------------------------------------
# Break-glass: publish from this machine (CI staging unavailable)
# -----------------------------------------------------------------------------
if [[ "$MODE" == "--publish" ]]; then
  # flair#1038: --publish is break-glass. The script used to print
  # "🚀 Publishing to npm..." and start publishing — indistinguishable from
  # the old laptop-login flow. Banner + acknowledgement first, before any
  # git/npm work, so a half-remembered procedure cannot reach publish.
  echo ""
  echo "⚠️  --publish is the BREAK-GLASS path. The normal release is:"
  echo "      git tag v${VERSION} && git push origin v${VERSION}"
  echo "    which stages every package via OIDC (no npm credential on any machine)."
  echo "    See docs/releasing.md. Continue only if CI staging is unavailable."
  echo ""

  if [[ "$ACK" == "--break-glass" ]]; then
    echo "Acknowledged via --break-glass."
  else
    echo "Type BREAK-GLASS to continue, or anything else to abort:"
    if ! read -r REPLY; then
      echo "❌ --publish requires an explicit acknowledgement."
      echo "   Re-run with --publish --break-glass if CI staging is unavailable."
      echo "   The normal release is: git tag v${VERSION} && git push origin v${VERSION}"
      exit 1
    fi
    if [[ "$REPLY" != "BREAK-GLASS" ]]; then
      echo "Aborted. Nothing was published."
      exit 1
    fi
  fi

  # Fail with our own message before npm's ENEEDAUTH names `npm login` as
  # the fix. Logging in would put a long-lived credential back on a machine
  # — the thing OIDC trusted publishing was adopted to eliminate.
  if ! npm whoami --registry https://registry.npmjs.org/ >/dev/null 2>&1; then
    echo "❌ This machine is not logged into npm."
    echo "   --publish publishes from THIS machine and is break-glass only."
    echo "   The normal release does not need npm credentials:"
    echo "     git tag v${VERSION} && git push origin v${VERSION}"
    echo "   That stages via OIDC. See docs/releasing.md."
    echo "   Do not run \`npm login\` unless CI staging is actually unavailable"
    echo "   and you are deliberately using this break-glass path."
    exit 1
  fi

  echo "=== Flair Release v${VERSION} — BREAK-GLASS PUBLISH ==="

  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "❌ Working tree is dirty. Check out main at the release commit."
    exit 1
  fi

  BRANCH="$(git -C "$ROOT" branch --show-current)"
  if [[ "$BRANCH" != "main" ]]; then
    echo "❌ --publish must run from main (on: $BRANCH)."
    exit 1
  fi

  echo "🔄 Pulling latest main..."
  git -C "$ROOT" pull --ff-only origin main

  # Verify every package.json is at the declared version — catches running
  # --publish before the release PR was actually merged.
  for pj in "${PACKAGE_JSONS[@]}"; do
    name="$(node -e "console.log(require('$pj').name)")"
    pv="$(node -e "console.log(require('$pj').version)")"
    if [[ "$pv" != "$VERSION" ]]; then
      echo "❌ $name is at $pv, expected $VERSION. Has the release PR been merged?"
      exit 1
    fi
  done

  # Same check the PR-prep path runs — covers the version declarations that are
  # not package.json files, which the loop above cannot see.
  (cd "$ROOT" && node scripts/check-version-sync.mjs "$VERSION") || exit 1

  if git -C "$ROOT" rev-parse "v${VERSION}" >/dev/null 2>&1; then
    echo "❌ Tag v${VERSION} already exists. Did you already publish?"
    exit 1
  fi

  echo "🔨 Building from merged main..."
  (cd "$ROOT" && npm run build && npm run build:cli) || { echo "❌ Build failed"; exit 1; }
  (cd "$ROOT/packages/flair-client" && npm run build) || { echo "❌ flair-client build failed"; exit 1; }
  (cd "$ROOT/packages/flair-mcp" && npm run build) || { echo "❌ flair-mcp build failed"; exit 1; }
  (cd "$ROOT/packages/n8n-nodes-flair" && npm run build) || { echo "❌ n8n-nodes-flair build failed"; exit 1; }

  echo "🚀 Publishing to npm..."
  echo "  Publishing @tpsdev-ai/flair-client..."
  (cd "$ROOT/packages/flair-client" && npm publish) || { echo "❌ flair-client publish failed"; exit 1; }

  echo "  Publishing @tpsdev-ai/flair-mcp..."
  (cd "$ROOT/packages/flair-mcp" && npm publish) || { echo "❌ flair-mcp publish failed"; exit 1; }

  echo "  Publishing @tpsdev-ai/flair..."
  (cd "$ROOT" && npm publish) || { echo "❌ flair publish failed"; exit 1; }

  # The five leaf packages below soft-fail so a break-glass publish of the core
  # three isn't blocked by, say, flair-bench's one-time Trusted Publisher
  # bootstrap (docs/releasing.md). That is a reasonable trade — but it used to
  # end with `git tag` and `✅ published and tagged` regardless, which is not
  # (flair#953). A partial publish rendered identically to a complete one, and
  # the tag then said a release shipped that a consumer cannot install: the root
  # package pins its internal deps at the exact version, so a missing leaf is a
  # broken install, not a missing extra.
  #
  # They still soft-fail individually. What changed is that the failures are
  # counted, named at the end, and block the tag.
  SOFT_FAILED=()
  soft_publish() {
    local dir="$1" name="$2" hint="${3:-}"
    echo "  Publishing ${name}..."
    if ! (cd "$ROOT/$dir" && npm publish); then
      echo "⚠️  ${name} publish failed${hint:+ ($hint)}"
      SOFT_FAILED+=("$name")
    fi
  }

  soft_publish "packages/openclaw-flair"  "@tpsdev-ai/openclaw-flair"  "may need build step"
  soft_publish "packages/pi-flair"        "@tpsdev-ai/pi-flair"        "may need build step"
  soft_publish "packages/n8n-nodes-flair" "@tpsdev-ai/n8n-nodes-flair"
  soft_publish "packages/langgraph-flair" "@tpsdev-ai/langgraph-flair" "may need build step"
  soft_publish "packages/adk-flair-js"     "@tpsdev-ai/adk-flair"     "may need build step"
  # Until the one-time bootstrap in docs/releasing.md is done (first manual
  # publish + npm Trusted Publisher registration), this is expected to fail on a
  # brand-new install of the package.
  soft_publish "packages/flair-bench"     "@tpsdev-ai/flair-bench"     "may need build step, or first-publish bootstrap — see docs/releasing.md"

  if (( ${#SOFT_FAILED[@]} > 0 )); then
    echo ""
    echo "❌ ${#SOFT_FAILED[@]} package(s) did NOT publish:"
    for p in "${SOFT_FAILED[@]}"; do echo "     - $p"; done
    echo ""
    echo "   NOT tagging v${VERSION}. A tag asserts that this version shipped; it did not."
    echo "   The core packages above ARE published — this is a partial release."
    echo "   Publish the packages listed above, then re-run to tag, or tag by hand"
    echo "   once you have decided the partial release is what you want."
    exit 1
  fi

  echo "🏷️  Tagging v${VERSION} on main..."
  git -C "$ROOT" tag -a "v${VERSION}" -m "Release v${VERSION}"
  git_push_auth "v${VERSION}"

  echo ""
  echo "✅ Flair v${VERSION} published and tagged (all 8 packages)."
  exit 0
fi

# -----------------------------------------------------------------------------
# Phase 1: prepare release PR
# -----------------------------------------------------------------------------
echo "=== Flair Release v${VERSION} — PR PREP ==="

# 1. Validate git state
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH="$(git -C "$ROOT" branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "⚠️  Not on main (on: $BRANCH). Release PRs must branch from main."
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

echo "🔄 Pulling latest main..."
git -C "$ROOT" pull --ff-only origin main

# 1b. Preflight the version declarations BEFORE anything destructive happens.
# The version lives in more than just the package.json files, and a site this
# script does not bump fails CI on the release PR — after the branch exists, the
# changelog fragments have been consumed and deleted, and the PR is open.
# Recovering from a half-run release is the expensive part, so this runs while
# the tree is still untouched. It verifies the CURRENT version is consistent
# everywhere and that no file outside the known set declares it.
echo "🔍 Preflighting version declarations..."
(cd "$ROOT" && node scripts/check-version-sync.mjs) || {
  echo "❌ Version declarations are out of sync on main — fix before releasing. Nothing was changed."; exit 1;
}

RELEASE_BRANCH="release/v${VERSION}"
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  echo "❌ Branch $RELEASE_BRANCH already exists locally. Delete it first if re-running."
  exit 1
fi

echo "🌿 Creating $RELEASE_BRANCH..."
git -C "$ROOT" checkout -b "$RELEASE_BRANCH"

# 1a. Assemble the changelog fragments into this version's section.
# Entries live one-per-file under .changelog/unreleased/ (flair#835) so
# concurrent PRs never conflict on CHANGELOG.md. This turns them into a
# `## [$VERSION] - <date>` section and deletes the fragment files; released
# history above it is untouched. It refuses to run when there are no fragments
# (an empty release section) or when someone hand-wrote an entry into
# `## [Unreleased]` that this step would otherwise overwrite.
echo "📰 Assembling changelog fragments..."
(cd "$ROOT" && node scripts/changelog-fragments.mjs promote "$VERSION") || {
  echo "❌ Changelog assembly failed — fix the fragments before releasing."; exit 1;
}

# 2. Bump versions in all package.json files
echo "📦 Bumping all packages to v${VERSION}..."
for pkg in "${PACKAGES[@]}"; do
  name="$(node -e "console.log(require('$pkg/package.json').name)")"
  node -e "
    const fs = require('fs');
    const path = '$pkg/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ $name → $VERSION"
done

# 2a. Bump the version declarations that are NOT package.json files.
# packages/flair-bench/src/version.ts holds TOOL_VERSION as a plain constant
# (a runtime JSON import of package.json trips NodeNext import-attribute edges
# in the published dist/), and a flair-bench package test asserts the two are
# equal. Step 5 below runs only test/unit, test/integration and
# test/unit-isolated — the flair-bench package tests are a separate CI job — so
# skipping this bumped cleanly, tested green locally, and went red in CI every
# single release. The rewrite lives in check-version-sync.mjs alongside the
# pattern that verifies it, so the two cannot drift.
echo "📌 Bumping source version declarations..."
(cd "$ROOT" && node scripts/check-version-sync.mjs --write "$VERSION") || {
  echo "❌ Source version bump failed"; exit 1;
}

# 3. Update internal dependencies (flair-mcp + pi-flair + n8n-nodes-flair all
#    depend on flair-client)
echo "🔗 Aligning internal dependencies..."
for INTERNAL_DEPENDENT in \
    "$ROOT/packages/flair-mcp/package.json" \
    "$ROOT/packages/pi-flair/package.json" \
    "$ROOT/packages/n8n-nodes-flair/package.json" \
    "$ROOT/packages/openclaw-flair/package.json" \
    "$ROOT/packages/langgraph-flair/package.json"; do
  node -e "
    const fs = require('fs');
    const path = '$INTERNAL_DEPENDENT';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (pkg.dependencies?.['@tpsdev-ai/flair-client']) {
      pkg.dependencies['@tpsdev-ai/flair-client'] = '$VERSION';
      fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
      console.log('  ✓ ' + pkg.name + ' → flair-client: $VERSION');
    }
  "
done

# Re-run the same check, now asserting the NEW version. The preflight above
# proves the tree was consistent; this proves the bump covered every site it
# knew about. It runs before the slow install/build/test so a miss costs seconds,
# and still before the commit, so nothing half-bumped can be pushed.
echo "🔍 Verifying every version declaration is at v${VERSION}..."
(cd "$ROOT" && node scripts/check-version-sync.mjs "$VERSION") || {
  echo "❌ Post-bump version check failed — do not push this branch."; exit 1;
}

# 3a. Refresh bun.lock so CI's --frozen-lockfile passes post-bump.
# Omitting this was the 0.5.6 release failure: version bumps desynced the
# lockfile, --frozen-lockfile killed every CI job at install.
echo "🔒 Refreshing bun.lock..."
(cd "$ROOT" && bun install) || { echo "❌ bun install failed"; exit 1; }

# 3b. `bun install` does NOT rewrite the workspace internal-dep specifiers in
# bun.lock's per-package sections: the leaf packages (langgraph/n8n/
# openclaw/pi-flair) keep the OLD @tpsdev-ai/flair-client version even though
# their package.json now declares $VERSION. `bun install` above passes, so it
# looks clean — but any downstream `--frozen-lockfile` install fails on the
# desync. This bit both v0.18.0 and v0.19.0 (each needed a manual fixup; Kern
# caught the v0.19.0 one on the release PR). Explicitly align every leaf
# specifier to $VERSION (the @workspace: resolution line and non-flair-client
# deps are left
# untouched — the regex only matches the "x.y.z" version-string form), then
# HARD-VERIFY with --frozen-lockfile so a residual desync fails the release loud
# instead of silently shipping a broken lockfile.
echo "🔗 Aligning bun.lock internal-dep specifiers..."
perl -i -pe 's{("\@tpsdev-ai/flair-client":\s*")\d+\.\d+\.\d+(")}{${1}'"$VERSION"'${2}}g' "$ROOT/bun.lock"
(cd "$ROOT" && bun install --frozen-lockfile) || {
  echo "❌ bun.lock still desynced after specifier alignment — investigate before releasing."; exit 1;
}

# 4. Build
echo "🔨 Building..."
(cd "$ROOT" && npm run build && npm run build:cli) || { echo "❌ Build failed"; exit 1; }
(cd "$ROOT/packages/flair-client" && npm run build) || { echo "❌ flair-client build failed"; exit 1; }
(cd "$ROOT/packages/flair-mcp" && npm run build) || { echo "❌ flair-mcp build failed"; exit 1; }
(cd "$ROOT/packages/n8n-nodes-flair" && npm run build) || { echo "❌ n8n-nodes-flair build failed"; exit 1; }
echo "  ✓ All packages built"

# 5. Test
# Scope matches CI's test job split: unit + integration under bun. Playwright
# e2e specs live under test/e2e/ and fail to load under bun — they're run via
# `bunx playwright test` against a live server in CI, not locally here.
echo "🧪 Running tests..."
# UNIT AND INTEGRATION RUN IN SEPARATE PROCESSES, because that is what CI does
# and the comment above only claimed to match it.
#
# This line used to be a single `bun test test/unit/ <integration files>`. CI
# runs them as two independent JOBS (test.yml's unit lane and its
# `bun test $(find test/integration ...)` lane), so nothing anywhere had ever
# executed the two suites in one bun process — except this script, once per
# release.
#
# Measured cutting 0.37.0, on the same commit CI had just passed 26/26:
#   unit alone                3912 pass  0 fail
#   integration alone          438 pass  0 fail
#   unit + integration        4350 pass  1 fail   <- only this shape
# The casualty was mcp-client-credentials-e2e, from the same family that already
# needed test/integration-isolated/ for exactly this reason (flair#691).
#
# So the release gate was failing for a reason unrelated to the release, on a
# combination no other lane runs. A gate that fails for the wrong reason is worse
# than a missing one: it trains everyone to re-run it until it passes.
# `test/*.test.ts` — the 12 root-level files — are in CI's unit lane
# (`bun test test/unit/ test/*.test.ts`) and were NOT in this script's. So the
# release gate ran LESS than CI while its comment claimed to match it, and the
# gap included auth-scoping, data-scoping, backup-restore and content-safety.
# 252 tests that no release has ever executed. They pass on macOS in under a
# second; there was no reason for the omission beyond nobody comparing the two
# invocations.
# flair#1012: darwin-gated launchd tests are skipped on Linux CI and used
# to surface only here, on macOS, as a bare "Tests failed" after the full
# suite. Run the inventory/execution gate first so a darwin-only failure
# is named as one, and so a Linux release host still reports the skip
# count instead of looking like those tests do not exist.
if ! (cd "$ROOT" && node scripts/check-darwin-gated-tests.mjs); then
  echo "❌ Tests failed (darwin-gated unit tests — flair#1012)"
  if [[ "$(uname -s)" == Darwin ]]; then
    echo "   This host is macOS. These tests exercise the launchd branch Linux CI skips."
    echo "   Compare the failing file against main on this same host before treating it as a release-branch regression."
  else
    echo "   This host is not macOS. The gate failed because the skip inventory is broken, not because a launchd test ran."
  fi
  exit 1
fi
if ! (cd "$ROOT" && bun test test/unit/ test/*.test.ts); then
  echo "❌ Tests failed (unit)"
  if [[ "$(uname -s)" == Darwin ]]; then
    echo "   This host is macOS. The unit suite includes darwin-gated launchd tests that Linux CI skips (flair#1012)."
    echo "   If the failure is in a darwin-gated file, compare against main on this host — it is not a failure CI would have seen."
  fi
  exit 1
fi
(cd "$ROOT" && bun test $(find test/integration -name '*.test.ts' | sort)) || { echo "❌ Tests failed (integration)"; exit 1; }
# test/unit-isolated/ files mock.module a process-global shared module; each
# MUST run in its own `bun test` process — they poison the real-importer
# files AND each other otherwise (flair#691).
for f in "$ROOT"/test/unit-isolated/*.test.ts; do
  (cd "$ROOT" && bun test "$f") || { echo "❌ Tests failed ($f)"; exit 1; }
done
# test/integration-isolated/: structurally excluded from the `find test/integration`
# glob above; each file runs in its own process to prevent env cross-contamination
# (flair#691, flair#1061).
for f in "$ROOT"/test/integration-isolated/*.test.ts; do
  (cd "$ROOT" && bun test "$f") || { echo "❌ Tests failed ($f)"; exit 1; }
done
echo "  ✓ Tests passed"

# 6. Commit version bump (explicit paths — no -A)
echo "📝 Committing version bump..."
git -C "$ROOT" add \
  "$ROOT/package.json" \
  "$ROOT/packages/flair-client/package.json" \
  "$ROOT/packages/flair-mcp/package.json" \
  "$ROOT/packages/openclaw-flair/package.json" \
  "$ROOT/packages/pi-flair/package.json" \
  "$ROOT/packages/n8n-nodes-flair/package.json" \
  "$ROOT/packages/langgraph-flair/package.json" \
  "$ROOT/packages/adk-flair-js/package.json" \
  "$ROOT/packages/flair-bench/package.json" \
  "$ROOT/packages/flair-bench/src/version.ts" \
  "$ROOT/packages/adk-flair/pyproject.toml" \
  "$ROOT/bun.lock"

# The fragment files consumed by step 1a are DELETED, so this needs -A to stage
# the removals — scoped to that one directory by pathspec, never repo-wide.
git -C "$ROOT" add -A -- "$ROOT/.changelog"

# Also stage CHANGELOG.md and scripts/release.sh if they have pre-staged changes —
# CHANGELOG.md is always modified by the fragment assembly in step 1a, and script
# bugfixes (like the missing langgraph-flair stage line, 2026-05-14) need to ride
# along with the release that surfaces them.
for extra in "$ROOT/CHANGELOG.md" "$ROOT/scripts/release.sh" "$ROOT/scripts/check-version-sync.mjs"; do
  if ! git -C "$ROOT" diff --quiet -- "$extra"; then
    git -C "$ROOT" add "$extra"
  fi
done
git -C "$ROOT" commit -m "release: v${VERSION} — align all workspace packages"

if [[ "$MODE" == "--dry" ]]; then
  echo ""
  echo "🏁 Dry run complete. All packages at v${VERSION}, built and tested, commit on $RELEASE_BRANCH."
  echo "   To open PR: re-run without --dry after resetting the branch."
  exit 0
fi

# 7. Push branch + open PR
echo "📤 Pushing $RELEASE_BRANCH..."
# No -u upstream tracking: the PAT-in-URL push can't double as a tracking remote
# without leaking the token into .git/config. The release flow doesn't need
# tracking — it pushes once and opens the PR via the API below.
git_push_auth "$RELEASE_BRANCH"

echo "🔖 Opening release PR..."
# Open the PR via the REST API rather than `gh pr create`: the flint token 401s on
# `gh pr create` (it goes through GraphQL), but `gh api` (REST) works. Build the
# JSON payload with node so the multi-line body is escaped correctly.
PR_PAYLOAD="$(mktemp)"
trap 'rm -f "$PR_PAYLOAD"' EXIT
PR_TITLE="release: v${VERSION}" PR_HEAD="$RELEASE_BRANCH" PR_VERSION="$VERSION" node -e '
  const body = `Version bump across workspace packages to v${process.env.PR_VERSION}.

See CHANGELOG.md for what'"'"'s in this release.

After CI is green and this is merged, tag the release (OIDC staging — no npm login):
\`\`\`
git checkout main && git pull
git tag -a v${process.env.PR_VERSION} -m "v${process.env.PR_VERSION}" && git push origin v${process.env.PR_VERSION}
\`\`\`

Break-glass only, if CI staging is unavailable:
\`\`\`
./scripts/release.sh ${process.env.PR_VERSION} --publish
\`\`\`
See docs/releasing.md.`;
  process.stdout.write(JSON.stringify({
    title: process.env.PR_TITLE,
    head: process.env.PR_HEAD,
    base: "main",
    body,
  }));
' > "$PR_PAYLOAD"
PR_URL="$($GH api -X POST repos/tpsdev-ai/flair/pulls --input "$PR_PAYLOAD" --jq '.html_url')"

echo ""
echo "✅ Release PR opened: $PR_URL"
echo ""
echo "Next steps:"
echo "  1. Wait for CI green on the PR"
echo "  2. Merge via GitHub UI (or: $GH pr merge --squash --repo tpsdev-ai/flair <num>)"
echo "  3. git checkout main && git pull"
echo "  4. git tag -a v${VERSION} -m \"v${VERSION}\" && git push origin v${VERSION}"
echo "     → triggers release-publish.yml, which stage-publishes via OIDC."
echo "       Approve the staged packages on npmjs.com (2FA)."
echo ""
echo "  Break-glass only, if CI staging is unavailable:"
echo "    ./scripts/release.sh ${VERSION} --publish"
echo "  This publishes from THIS machine and requires an npm login. See docs/releasing.md."
