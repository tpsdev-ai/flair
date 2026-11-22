- **Harper is pinned to 5.3.6.**
  Its bundled dependencies are absent from `bun.lock` and are not replaced by
  root overrides. `node scripts/ci/list-harper-bundled.mjs` lists installed
  bundled copies and their versions. ([#2803](https://github.com/tpsdev-ai/flair/pull/2803))
