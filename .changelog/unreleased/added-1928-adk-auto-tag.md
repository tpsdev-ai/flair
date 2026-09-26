- **The release tagger also marks the Python package.** When the release commit's
  tree carries `packages/adk-flair/pyproject.toml` at the very version being
  tagged, the auto-tagger creates `adk-flair-v<version>` from the SAME commit as
  `v<version>`, so the PyPI publish no longer waits for a hand-pushed tag. A tree
  without the file skips the second tag (flair releases without the Python
  package); a tree whose version differs refuses `adk-version-mismatch` BEFORE
  either tag is written; an `adk-flair-v<version>` that already exists at another
  commit refuses `adk-tag-exists-elsewhere`; and a rejected second POST refuses
  `adk-ref-write-rejected`, leaving the `v` tag in place and never retrying.

  > **Heads-up:** a repo admin must list the release-tag App as a bypass actor on
  > the `adk-flair-v*` tag ruleset. Until then the second POST is rejected (403)
  > and the release refuses with `adk-ref-write-rejected`.
