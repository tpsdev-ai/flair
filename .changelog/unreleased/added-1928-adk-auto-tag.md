- **The release tagger also marks the Python package.** When the release commit's
  tree carries `packages/adk-flair/pyproject.toml` at the very version being
  tagged, the auto-tagger creates `adk-flair-v<version>` from the SAME commit as
  `v<version>`, so the PyPI publish no longer waits for a hand-pushed tag. The tagger
  skips the second tag when the file is absent, but the version-sync checker lists
  the pyproject as a source file, so removing the Python package also removes it
  there and from the paths `scripts/release.sh` stages, and only then is a release
  tagged `v` alone; the `[project]` version is read with Python's `tomllib` — the SAME
  reader `.github/workflows/adk-flair-publish.yml` decides with — so a
  `version =` line inside a multi-line string or array is never mistaken for the
  project version. The reader fails CLOSED: a TOML parse error, a `python3`
  without `tomllib`, or a `[project]` that is not a table refuses
  `adk-pyproject-unsupported` naming the reason; a `dynamic` version or a missing
  `[project].version` refuses `adk-version-mismatch`; and a version that differs
  refuses `adk-version-mismatch` BEFORE either tag is written. An
  `adk-flair-v<version>` already at another commit refuses `adk-tag-exists-elsewhere`
  without writing the `v` tag; a rejected second POST refuses
  `adk-ref-write-rejected`, leaving the `v` tag in place and never retrying (for a
  403 the text names the App's ruleset bypass setting as the first thing to check,
  then the re-run). An adk ref read that fails refuses `adk-ref-unreadable` rather
  than throwing, except after a rejected POST, where the refusal stays
  `adk-ref-write-rejected` and the read-back is reported as `not read`. The `tomllib` reader
  runs `python3 -I` with only `PATH` in its environment, so a module in the
  checkout cannot shadow the standard library and no token reaches it. The
  post-POST read-back has THREE distinct refusals, each reporting only what that run
  OBSERVED: the ref did not read back at all (MISSING); it read back but could not
  be resolved to a commit (UNRESOLVED); or it resolves elsewhere. The rejected-POST
  and elsewhere texts name the two refs' read-back values (the raw ref type and SHA
  when unresolvable, or `not found`) and the check the operator runs next. The
  pyproject's membership+read is ONE function: a `git ls-tree` that does not answer
  exactly "absent" or "the path", or a failed `git show`, refuses
  `adk-pyproject-unreadable` before any POST on BOTH paths; no stderr substring
  decides anything. The `[project]` version is read by tomllib with `dynamic`
  checked BEFORE a static `version` line, so `dynamic = ["version"]` plus a stray
  `version` line has NO project version (and refuses `adk-version-mismatch`). The
  version WRITER (`scripts/check-version-sync.mjs --write`) precomputes the two
  `SOURCE_VERSION_FILES` edits (`packages/flair-bench/src/version.ts` and
  `packages/adk-flair/pyproject.toml`), verifies the pyproject edit with `tomllib`
  (refused unless only `project.version` changed) and the flair-bench edit with its
  own declaration check, writes NOTHING if either fails, and leaves the
  `package.json` bumps to `release.sh`; it replaces only the version bytes so a
  mixed CRLF/LF file keeps every other byte intact. Each guarantee names its test in
  `test/unit/release-auto-tag.test.ts` and
  `test/unit/release-auto-tag-workflow.test.ts`.

  > **Heads-up:** a repo admin must list the release-tag App as a bypass actor on
  > the `adk-flair-v*` tag ruleset (id 24044018). Until then the second POST is
  > rejected (403) and the release refuses with `adk-ref-write-rejected`.
