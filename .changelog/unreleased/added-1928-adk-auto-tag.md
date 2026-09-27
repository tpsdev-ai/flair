- **The release tagger also marks the Python package.** When the release commit's
  tree carries `packages/adk-flair/pyproject.toml` at the very version being
  tagged, the auto-tagger creates `adk-flair-v<version>` from the SAME commit as
  `v<version>`, so the PyPI publish no longer waits for a hand-pushed tag. A tree
  without the file skips the second tag (flair releases without the Python
  package); the `[project]` version is read with Python's `tomllib` — the SAME
  reader `.github/workflows/adk-flair-publish.yml` decides with — so a
  `version =` line inside a multi-line string or array is never mistaken for the
  project version. The reader fails CLOSED: a TOML parse error, a `python3`
  without `tomllib`, or a `[project]` that is not a table refuses
  `adk-pyproject-unsupported` naming the reason; a `dynamic` version or a missing
  `[project].version` refuses `adk-version-mismatch`; and a version that differs
  refuses `adk-version-mismatch` BEFORE either tag is written. An
  `adk-flair-v<version>` already at another commit refuses `adk-tag-exists-elsewhere`
  without writing the `v` tag; a rejected second POST refuses
  `adk-ref-write-rejected`, leaving the `v` tag in place and never retrying. The
  post-POST read-back has THREE distinct refusals: the ref did not read back at all
  (MISSING); it read back but could not be resolved to a commit (UNRESOLVED — a
  human should inspect the ref); or it resolves elsewhere. A re-run writes
  `adk-flair-v<version>` only if it is still absent and the checks still pass — the
  text never promises it. The `[project]` version is read by tomllib with `dynamic`
  checked BEFORE a static `version` line, so `dynamic = ["version"]` plus a stray
  `version` line has NO project version (and refuses `adk-version-mismatch`). The
  version WRITER (`scripts/check-version-sync.mjs --write`) is ALL-OR-NOTHING —
  every replacement is computed first and if ANY refuses it writes NOTHING — and
  each edit is re-verified with `tomllib` (refused unless only `project.version`
  changed and equals the requested version), replacing only the version bytes so a
  mixed CRLF/LF file keeps every other byte intact. Each guarantee names its test in
  `test/unit/release-auto-tag.test.ts` and
  `test/unit/release-auto-tag-workflow.test.ts`.

  > **Heads-up:** a repo admin must list the release-tag App as a bypass actor on
  > the `adk-flair-v*` tag ruleset (id 24044018). Until then the second POST is
  > rejected (403) and the release refuses with `adk-ref-write-rejected`.
