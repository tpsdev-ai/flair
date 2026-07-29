- **Five gates that could report success without checking anything (flair#953,
  sweep).** Auditing the class behind the docs-freshness skip — the absence of a
  result rendering identically to a passing result — turned up these, each
  verified against real CI logs or a reproduced failure rather than by reading
  the code:

  - **250 tests in `test/*.test.ts` were run by no CI job and no release gate.**
    Every `bun test` invocation in every workflow is directory-scoped, and a
    directory filter does not match root-level files, so twelve suites — six of
    them security-scoping (auth scoping, data scoping, content safety, key
    rotation, agent grants, backup/restore) — were never executed by CI. A bare
    `bun test`, which `CONTRIBUTING.md` tells contributors to run, does pick them
    up, so they passed locally and were enforced nowhere. Confirmed by grepping
    28.6 MB of historical CI logs for each suite's `describe()` name: zero hits
    each, against positive controls from `test/unit/` at 192 and 240 hits. They
    are now in the unit lane and all 250 pass.

  - **The implementation-term leak gate reported clean when its scan failed.**
    `grep`'s exit status was discarded with `|| true`, collapsing "grep itself
    failed" (unreadable file, argument-list overflow) into "no matches found";
    the file list was word-split, so a path containing a space was silently never
    scanned; and an empty corpus printed "No files to search." and exited 0. All
    three now fail loudly, and the file count is reported so a shrinking corpus
    is visible.

  - **`release.sh` tagged a partial publish as a complete release.** Five of the
    eight packages soft-fail on publish so a break-glass release of the core
    three isn't blocked — but the script then tagged and printed "published and
    tagged" regardless. Since the root package pins its internal dependencies at
    the exact version, a missing package is a broken install rather than a
    missing extra. The soft-fails are retained; they are now counted, named, and
    block the tag.

  - **A workspace package with no `tsconfig.json` was silently exempt from type
    checking.** It printed one "Skipping" line into a folded log and left the job
    green, so a package that lost its tsconfig in a refactor would have had zero
    type coverage with the same signal as a clean check. Exclusions are now an
    explicit allowlist, an unlisted skip fails, and a run that type-checks zero
    packages fails.

  - **`changelog-fragments check` skipped its stray-entry rule when the
    `## [Unreleased]` header was missing**, making the PR-time check strictly
    weaker than the release-time one, which refuses on the same condition. A
    mangled header passed CI and detonated mid-release-cut instead. It now fails
    where `promote` would.

  `test/unit/ci-gate-coverage.test.ts` pins these as invariants rather than as
  string matches: it enumerates every test file on disk and asserts CI reaches
  all of them, and enumerates every workspace package and asserts each is
  type-checked or explicitly excused. Adding a test directory no job runs, or a
  package nobody type-checks, fails there.
