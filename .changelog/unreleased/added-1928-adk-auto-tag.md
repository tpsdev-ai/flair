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
  `adk-ref-write-rejected`, leaving the `v` tag in place and never retrying; and a
  MISSING adk read-back after the POST has its OWN refusal (the ref did not read
  back; re-run on this commit) — which then skips the `v` POST and writes only
  `adk-flair-v<version>`, completing the release. The version WRITER
  (`scripts/check-version-sync.mjs --write`) re-verifies every edit with `tomllib`
  and refuses (writes nothing) unless only `project.version` changed and it equals
  the requested version, preserving line endings. Each guarantee names its test in
  `test/unit/release-auto-tag.test.ts` and
  `test/unit/release-auto-tag-workflow.test.ts`.

  > **Heads-up:** a repo admin must list the release-tag App as a bypass actor on
  > the `adk-flair-v*` tag ruleset (id 24044018). Until then the second POST is
  > rejected (403) and the release refuses with `adk-ref-write-rejected`.
