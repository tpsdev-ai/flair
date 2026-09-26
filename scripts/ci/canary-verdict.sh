#!/usr/bin/env bash
# canary-verdict.sh — the post-publish canary's PASS/FAIL output (flair#1686,
# flair#1781, flair#1671 slice A1c).
#
# This is the single definition of what the canary tells a human to do. It is a
# script, not prose in the workflow, so the exact package-set-digest-bound promote
# block (or the deprecate lines) can be exercised directly.
#
# flair#1781: the promote is LOCKSTEP. The release stages the lockstep set (nine
# packages today) together, so the promote must move all of them — a partial
# paste leaves `latest` skewed across the set (the flair#1383 mismatch class).
# The package list is DERIVED from the manifests by
# `scripts/ci/lockstep-packages.mjs`; it is never copied here.
#
# A1c (flair#1671): the promote block is bound to a SINGLE package-set digest,
# not to one sha256 per package. The release run's pack job (A1a, #1877) records
# that digest — sha256 over the canonical sorted list of "<name>@<version>
# <sha256>" lines, one per lockstep package — and prints it in the run summary.
# The canary verifies the same digest (the sha step of canary.yml) and the
# emitted preflight re-derives it from the registry at PASTE TIME and tests it
# against the digest the canary verified, BEFORE any tag can move.
#
# Prereleases are never promoted. A SemVer prerelease label means the version was
# published on the `next` dist-tag, not `latest`; the PASS path of a prerelease
# prints a one-line note and no promote block, so a human is never asked to move
# `latest` to a prerelease. The FAIL branch is unchanged.
#
# PASS emits ONE block the operator pastes once, in THREE phases: a preflight that
# re-derives the package-set digest from the published tarballs and requires it to
# equal the release run's digest (nothing moves if the check fails — so a registry
# hiccup or a re-cut version mid-paste cannot leave a partial promote), then the
# `npm dist-tag add` lines (`@tpsdev-ai/flair` LAST), then the skew check.
#
# bash 3.2-safe (flair#1781 R0): the macOS canary leg runs this under stock
# /bin/bash 3.2, so this file uses NO bash-4 feature (no `declare -A`, no
# `mapfile`). A too-old shell fails fast with a clear message, never a feature
# syntax error.
#
# Usage:
#   scripts/ci/canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] [--package-set-digest <64-hex>]
#
#   --package-set-digest <64-hex> is REQUIRED for the pass path: the digest the
#   release run certified, against which the emitted preflight re-derives from the
#   registry at paste time. For a prerelease <version> it is ignored (no promote
#   block is printed).
#
# Output is Markdown, suitable for `tee -a "$GITHUB_STEP_SUMMARY"`.
#
# flair#1856 R2: the emitted preflight pipes each per-package re-hash through the
# SAME 64-hex check before folding it into the digest, and re-checks the
# re-derived digest for 64 hex before comparing — so an unmeasurable tarball (a
# re-hash of "") is a REFUSAL, never a match.
#
# The promote guard hashes the PUBLISHED tarball, not `dist.shasum` (a SHA-1 that
# could never equal a sha256). It runs from the repo checkout because
# `registry-tarball-sha256.mjs` / `package-set-digest.mjs` live there, and
# `@tpsdev-ai/flair` is emitted LAST so a partial paste never leaves the CLI ahead
# of its client library.
#
# Exit: 0 emitted; 2 DID NOT RUN / usage error.

set -euo pipefail

# ── bash floor (flair#1781 R0/R5) ───────────────────────────────────────────
# Keep the whole file to bash 3.2 features; fail fast and clearly on anything
# older. `BASH_VERSION` is unset under a plain sh.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "canary-verdict.sh: must run under bash (bash 3.2+)" >&2
  exit 2
fi
_bash_major="${BASH_VERSION%%.*}"
_bash_rest="${BASH_VERSION#*.}"
_bash_minor="${_bash_rest%%.*}"
if [ "${_bash_major:-0}" -lt 3 ] || { [ "${_bash_major:-0}" -eq 3 ] && [ "${_bash_minor:-0}" -lt 2 ]; }; then
  echo "canary-verdict.sh: bash ${BASH_VERSION} is too old — bash 3.2+ is required (stock macOS /bin/bash is 3.2)" >&2
  exit 2
fi

VERDICT="${1:-}"
VERSION="${2:-}"
RUN_URL="${3:-}"

if [ "$VERDICT" != "pass" ] && [ "$VERDICT" != "fail" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] [--package-set-digest <64-hex>]" >&2
  exit 2
fi
if [ -z "$VERSION" ]; then
  echo "usage: canary-verdict.sh <pass|fail> <version> <run-url> [--os <os>] [--package-set-digest <64-hex>] — version is required" >&2
  exit 2
fi

if [ "$#" -ge 3 ]; then shift 3; fi

# Parse `[--os <os>]` and `[--package-set-digest <64-hex>]`. bash 3.2: no arrays
# of bindings — the promote is bound to ONE package-set digest (A1c, #1671).
OS_NAME="linux"
PKG_SET_DIGEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
      --os) OS_NAME="${2:-}"; shift 2 ;;
      --os=*) OS_NAME="${1#--os=}"; shift ;;
      --package-set-digest) PKG_SET_DIGEST="${2:-}"; shift 2 ;;
      --package-set-digest=*) PKG_SET_DIGEST="${1#--package-set-digest=}"; shift ;;
      *) echo "canary-verdict.sh: unexpected argument '$1'" >&2; exit 2 ;;
  esac
done

# Promotability is a WHITELIST (F2 of #1671, A1c): the promote block is
# emitted ONLY for a version that is exactly `<major>.<minor>.<patch>`.
# Everything else — a SemVer prerelease (`1.2.3-rc.1`, the bare `1.2.3-0`
# or `1.2.3--`), build metadata (`1.2.3+build`), or any other label — is NOT
# a release and is never promoted to `latest` (a `-` label sits on `next`; a `+build`/no-`-` version sits on `staged`). A blacklist
# (matching a `-<prerelease>` part) misses `1.2.3--`, whose first `-` is a valid
# SemVer prerelease token, and would wrongly promote it; the whitelist cannot.
is_release() {
    # F2 (A1c of #1671): a WHOLE-STRING match, not a line match. `printf | grep -Eq`
    # matches any line of a multi-line value, so "1.2.3" followed by a newline and
    # garbage read as a release and print nine dist-tag lines. `[[ =~ ]]` matches the
    # whole string, so a value like "1.2.3\ngarbage" is refused: only an exact
    # <major>.<minor>.<patch> is promoted, everything else prints the note and nothing else.
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# The ONE source for the lockstep set (never a second list here).
PACKAGES=()
while IFS= read -r _line; do
  [ -n "$_line" ] && PACKAGES[${#PACKAGES[@]}]="$_line"
done < <(node scripts/ci/lockstep-packages.mjs)
if [ "${#PACKAGES[@]}" -eq 0 ]; then
  echo "canary-verdict.sh: DID NOT RUN — could not derive the lockstep package list (run from the repo root)" >&2
  exit 2
fi

emit_prerelease_note() {
  cat <<EOF
### Canary - \`${VERSION}\` is not a clean release and is **never** promoted to \`latest\` (\`${OS_NAME}\`)

This block promotes **only** an exact \`major.minor.patch\` to \`latest\`. \`${VERSION}\` is
not one, so **no promote block is printed and \`latest\` does not move** — a version this
block cannot promote is never pushed live. Where this version actually sits follows
release-publish.yml: a SemVer **prerelease** (a \`-\` label, such as \`1.2.3-rc.1\`) is
staged on the \`next\` dist-tag; anything **without** a \`-\` (for example a \`+build\` metadata
version such as \`1.2.3+20260101\`) is **not** a prerelease and is staged on \`staged\`
(the no-\`-\` branch), never \`next\`. Either way the version is **not** \`latest\`; a
\`+build\` version is **not** a prerelease and is **not** promoted by this block either.
EOF
}

if [ "$VERDICT" = "pass" ]; then
   # Only an exact `<major>.<minor>.<patch>` is promoted. Anything else
   # (a prerelease, build metadata, or any other label) prints the note and
   # stops: no promote block, no dist-tag line — a prerelease never moves `latest`.
  if ! is_release "$VERSION"; then
    emit_prerelease_note
    exit 0
  fi

  # The pass path requires the certified package-set digest to bind the promote.
     # F0 (A1c of #1671): a WHOLE-STRING match, not a line match. `printf | grep -Eq`
     # accepts a valid first line followed by a newline and garbage, so a 64-hex digest
     # carrying a trailing newline and junk read as valid. `[[ =~ ]]` matches the whole
     # string, so only an exact 64-char hex sha256 is accepted here.
  if ! [[ "$PKG_SET_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "canary-verdict.sh: DID NOT RUN — --package-set-digest is required and must be a 64-char hex sha256 (got '${PKG_SET_DIGEST}')" >&2
    exit 2
  fi

  cat <<EOF
### ✅ Canary PASS — \`${OS_NAME}\`

Promote ALL ${#PACKAGES[@]} lockstep packages to \`latest\`. **npm has no atomic,
all-or-none promote** — this block moves the tags SEQUENTIALLY and STOPS at the first
failure (the failing move exits non-zero). It reads every package's CURRENT \`latest\`
BEFORE the first move, and STOPS before moving a single tag if ANY read fails — a
non-zero npm exit, an empty read, or a value that is not a version — so it only
reaches the moves with a clean PREVIOUS \`latest\` for every package, and can RESTORE.
On the move-failure path it prints one RESTORE line per already-moved package
(\`npm dist-tag add <pkg>@<previous> latest\`, never \`npm dist-tag rm\`) and then the
packages it did NOT move; on the skew-failure path (where every package was moved)
it prints an explicit \`ALL N packages were moved\` line first, then the same RESTORE
lines for each. The convergence (skew) check runs ONLY on the all-succeeded
path. The preflight is bound to the release run's **package-set digest** — a single
sha256 over the canonical sorted list of \`<name>@${VERSION} <sha256>\` lines, one per
lockstep package (the digest \`${PKG_SET_DIGEST}\` the pack job certified). Paste this
WHOLE block once, from the repo root: it re-derives that digest from the published
tarballs FIRST, so a re-cut version or a different package set aborts BEFORE any tag
moves.

\`\`\`
set -e

# 1. Preflight — re-derive the package-set digest from the published tarballs and
#    require it to equal the release run's digest. Nothing below runs if the
#    re-derivation is empty, malformed, or a different digest.
PSD_LINES="\$(mktemp)"
PREV_LATEST="\$(mktemp)"
MOVED="\$(mktemp)"
trap 'rm -f "\$PSD_LINES" "\$PREV_LATEST" "\$MOVED"' EXIT
: > "\$PSD_LINES"
: > "\$PREV_LATEST"
: > "\$MOVED"
EOF
  # The paste-time loop re-hashes every lockstep package from the registry
  # (flair LAST, derived from the manifests above), refusing — never matching — if
  # any re-hash is empty or not 64 hex.
  cat <<EOF
for _p in ${PACKAGES[*]}; do
      # F4 (A1c of #1671): capture the producer's stdout AND its exit status SEPARATELY.
      # A grep -E pipe, which both filters a failing producer's output (a valid first line + garbage
      # from a producer that exits non-zero) AND reports grep's own status (0 on a match),
      # masking the non-zero exit. Instead: require the producer to exit 0 AND emit exactly
      # one line matching 64 hex; anything else is a refusal naming the package.
    set +e
    _out="\$(node scripts/ci/registry-tarball-sha256.mjs ${VERSION} "\$_p")"
    _out_status=\$?
    set -e
    if [ "\$_out_status" -ne 0 ]; then
      echo "canary promote preflight: refused — '\$_p' tarball hasher exited \$_out_status (unmeasurable is FAIL)" >&2
      exit 1
    fi
      _out_n="\$(printf '%s\n' "\$_out" | wc -l | tr -d '[:space:]')"
    if [ "\$_out_n" -ne 1 ]; then
      echo "canary promote preflight: refused — '\$_p' hasher emitted \$_out_n lines (exactly one 64-hex line is required; unmeasurable is FAIL)" >&2
      exit 1
    fi
    if ! [[ "\$_out" =~ ^[0-9a-f]{64}\$ ]]; then
      echo "canary promote preflight: refused — '\$_p' did not hash to a 64-char sha256 at paste time (unmeasurable is FAIL)" >&2
      exit 1
    fi
    printf '%s=%s\n' "\$_p" "\$_out" >> "\$PSD_LINES"
  done
# F4 (A1c of #1671): the producer's stdout and its exit status are captured
# SEPARATELY. A non-zero producer exit (even with a valid-looking first line)
# is a refusal, and the re-derived digest must be exactly ONE 64-hex line; a
# second line or trailing garbage is a refusal too. Wrapping the producer in
# set +e / set -e makes the capture robust under any shell, not only where
# set -e happens to catch a bad command substitution.
set +e
_rehash="\$(node scripts/ci/package-set-digest.mjs --version ${VERSION} < "\$PSD_LINES")"
_rehash_status=\$?
set -e
if [ "\$_rehash_status" -ne 0 ]; then
  echo "canary promote preflight: refused — the package-set digest producer exited \$_rehash_status (a non-zero producer is unmeasurable, so FAIL)" >&2
  exit 1
fi
if [ -z "\$_rehash" ]; then
  echo "canary promote preflight: refused — the package-set digest could not be re-derived from the registry (empty output; unmeasurable is FAIL)" >&2
  exit 1
fi
_rehash_lines=\$(printf '%s\n' "\$_rehash" | wc -l | tr -d '[:space:]')
if [ "\$_rehash_lines" -ne 1 ]; then
  echo "canary promote preflight: refused — the package-set digest producer emitted \$_rehash_lines lines (exactly one 64-hex line is required; unmeasurable is FAIL)" >&2
  exit 1
fi
       # F0 (A1c of #1671): a WHOLE-STRING match, not a line match. printf | grep -Eqx
       # accepts a valid first line followed by a newline and garbage; [[ =~ ]] matches
       # the whole string, so only an exact 64-char hex sha256 is accepted.
  if ! [[ "\$_rehash" =~ ^[0-9a-f]{64}\$ ]]; then
    echo "canary promote preflight: refused — the re-derived package-set digest is not a 64-char hex sha256 (unmeasurable is FAIL)" >&2
    exit 1
  fi
if [ "\$_rehash" != "${PKG_SET_DIGEST}" ]; then
  echo "canary promote preflight: refused — paste-time package-set digest \$_rehash differs from the release run's digest ${PKG_SET_DIGEST}; do not promote" >&2
  exit 1
fi
EOF
  cat <<EOF

# 2. Read each package's CURRENT latest BEFORE any move. If a read fails, NOTHING
#    has moved — stop here and say so.
for _p in ${PACKAGES[*]}; do
  # Capture npm's stdout and its exit status SEPARATELY. A (npm | sed) pipeline
  # reports sed's status (0 on a match), so an npm that FAILS while still printing
  # a "latest: 1.2.2" line would read as success. A failed read must stop here.
  set +e
  _ls="\$(npm dist-tag ls "\$_p" 2>/dev/null)"
  _ls_status=\$?
  set -e
  if [ "\$_ls_status" -ne 0 ]; then
    echo "canary promote: could not read the current latest of '\$_p' (npm dist-tag ls exited \$_ls_status; unmeasurable is FAIL) - NOTHING has moved; do not promote." >&2
    exit 1
  fi
  # Strip a trailing CR (CRLF registry output) and surrounding whitespace BEFORE
  # parsing, then require a version - the shape this block promotes. A malformed
  # value stops here; it never reaches a restore line.
  _cur="\$(printf '%s\n' "\$_ls" | sed -n 's/^latest: //p' | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*\$//')"
  if [ -z "\$_cur" ]; then
    echo "canary promote: could not read the current latest of '\$_p' (empty latest) - NOTHING has moved; do not promote." >&2
    exit 1
  fi
  if ! [[ "\$_cur" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\$ ]]; then
    echo "canary promote: the current latest of '\$_p' is not a version (raw '\$_cur') - NOTHING has moved; do not promote." >&2
    exit 1
  fi
  printf '%s=%s\n' "\$_p" "\$_cur" >> "\$PREV_LATEST"
done

# 3. Move the tags SEQUENTIALLY (\`@tpsdev-ai/flair\` LAST, so a partial paste never
#    leaves the CLI ahead of its client library), stopping at the FIRST failure. On
#    failure: a RESTORE line per already-moved package (its PREVIOUS latest - it never
#    deletes a tag), then the packages NOT moved. No skew check on this path.
_LPKGS="${PACKAGES[*]}"
for _p in \$_LPKGS; do
  if ! npm dist-tag add "\$_p@${VERSION}" latest; then
    echo "canary promote ABORTED at '\$_p' - npm is not atomic. RESTORE the packages already moved, in this order, each to its PREVIOUS latest (this does not delete a tag):" >&2
    while IFS= read -r _line; do
      _mp="\${_line%%=*}"; _mv="\${_line#*=}"
      echo "  npm dist-tag add \${_mp}@\${_mv} latest" >&2
    done < "\$MOVED"
    echo "NOT moved (still on their previous latest):" >&2
    _seen=0
    for _q in \$_LPKGS; do
      if [ "\$_q" = "\$_p" ]; then _seen=1; fi
      if [ "\$_seen" -eq 1 ]; then echo "  \$_q" >&2; fi
    done
    exit 1
  fi
  _pv="\$(grep -F "\${_p}=" "\$PREV_LATEST" | head -n 1 | cut -d= -f2- || true)"
  printf '%s=%s\n' "\$_p" "\$_pv" >> "\$MOVED"
done

# 4. Confirm the set converged — ONLY when every move succeeded.
if ! node scripts/ci/registry-latest-skew.mjs ${VERSION}; then
  echo "canary promote: the skew check failed AFTER every tag moved. ALL ${#PACKAGES[@]} packages were moved (none is still on its previous latest). RESTORE every moved package to its PREVIOUS latest (this does not delete a tag):" >&2
  while IFS= read -r _line; do
    _mp="\${_line%%=*}"; _mv="\${_line#*=}"
    echo "  npm dist-tag add \${_mp}@\${_mv} latest" >&2
  done < "\$MOVED"
  exit 1
fi
\`\`\`

A stale PASS, a re-cut version, a different package set, or a paste from a FAIL
aborts at the preflight — the re-derived digest never equals the certified
\`${PKG_SET_DIGEST}\` — before \`latest\` can move. The sha256 helper downloads
the published tarball, so it checks the exact bytes, not a tag.
EOF
else
  cat <<EOF
### ❌ Canary FAIL — \`${OS_NAME}\`

Do not promote. Deprecate EVERY lockstep package — the CLI FIRST (the likeliest
install target), so a partial paste warns it earliest. Paste these exact lines:

\`\`\`
EOF
  for ((i = ${#PACKAGES[@]} - 1; i >= 0; i--)); do
    p="${PACKAGES[$i]}"
    printf 'npm deprecate %s@%s "failed post-publish canary: %s"\n' "$p" "$VERSION" "$RUN_URL"
  done
  cat <<EOF

\`\`\`

Re-cut the next patch; never refresh this version.
EOF
fi
