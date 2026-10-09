- **Unit-file discovery and the lane coverage gate share one predicate for the names Bun's runner discovers (#2288).**
  Discovery previously accepted only `.test.[jt]sx?`. Both now accept the
  `.test`/`_test`/`.spec`/`_spec` suffixes with Bun's eight extensions (`js`,
  `jsx`, `ts`, `tsx`, `mjs`, `cjs`, `mts`, `cts`), so a unit test named
  `foo_test.ts` or `foo.test.mjs` is planned and checked instead of skipped.
