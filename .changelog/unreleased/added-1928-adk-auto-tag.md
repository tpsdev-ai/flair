- **The release tagger also marks the Python package.** When the release commit's
  tree carries `packages/adk-flair/pyproject.toml` at the very version being
  tagged, the auto-tagger creates `adk-flair-v<version>` from the SAME commit as
  `v<version>`, so the PyPI publish no longer waits for a hand-pushed tag. A tree
  without the file skips the second tag (flair releases without the Python
  package); the `[project]` version is read by a WHITELIST (a bare, unquoted
  `version = "<x>"` line inside `[project]` — `[table]`/`[[array-of-tables]]`
  headers END the table, and a `dynamic` version is NONE), so a tree whose version
  differs or is dynamic/absent refuses `adk-version-mismatch` BEFORE either tag is
  written, and any form the reader does not implement (a quoted or dotted key, an
  inline `project` table, an odd `version` line) refuses
  `adk-pyproject-unsupported` naming the line — never a guess; an
  `adk-flair-v<version>` already at another commit refuses `adk-tag-exists-elsewhere`
  without writing the `v` tag; and a rejected second POST refuses
  `adk-ref-write-rejected`, leaving the `v` tag in place and never retrying —
  re-running the workflow on the SAME commit then skips the `v` POST and writes
  only `adk-flair-v<version>`, completing the release. Each guarantee names its
  test in `test/unit/release-auto-tag.test.ts` ((a)–(o)) and
  `test/unit/release-auto-tag-workflow.test.ts`.

  > **Heads-up:** a repo admin must list the release-tag App as a bypass actor on
  > the `adk-flair-v*` tag ruleset (id 24044018). Until then the second POST is
  > rejected (403) and the release refuses with `adk-ref-write-rejected`.
