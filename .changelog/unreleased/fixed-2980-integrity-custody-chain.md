- **Integrity commits and tombstones check recorded custody identities around publication.**
  A detected change refuses an unpublished write or reports an uncertain
  published outcome. Initialization and the publication staging file are
  outside these identity comparisons. Changes between or after checks are not covered. ([#2988](https://github.com/tpsdev-ai/flair/pull/2988))
