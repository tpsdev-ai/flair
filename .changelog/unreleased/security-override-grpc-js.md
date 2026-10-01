- **A root dependency override for `@grpc/grpc-js` moves the repo lockfile out of the affected ranges of GHSA-f596-whhp-79r4 and GHSA-m9gg-hp2v-232j.**
  `@grpc/grpc-js` ^1.14.5 resolves 1.14.5 in `bun.lock`. In this repository the package comes
  only from `@google/adk`, a dependency of `@tpsdev-ai/adk-flair`; an npm install of
  `@tpsdev-ai/flair` does not include it. Root overrides do not apply to npm installs of a
  published package, so this one changes nothing for `@tpsdev-ai/adk-flair` under npm: npm
  resolves `@grpc/grpc-js` from the ranges in `@google/adk`'s dependency tree, and a fresh npm
  install of `@tpsdev-ai/adk-flair` 0.57.0 on 2026-09-30 resolved 1.14.5. An install whose
  lockfile already records an affected version keeps it until that lockfile's `@grpc/grpc-js`
  entry changes. Flair's own code imports no gRPC package.
