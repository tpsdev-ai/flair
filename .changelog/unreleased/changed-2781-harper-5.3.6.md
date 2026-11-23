- **Harper is pinned to 5.3.6.**
  The copies Harper bundles inside its own package are not described by
  `bun.lock` and are not replaced by root overrides. `node scripts/ci/list-harper-bundled.mjs`
  lists installed bundled copies and their versions. ([#2803](https://github.com/tpsdev-ai/flair/pull/2803))
