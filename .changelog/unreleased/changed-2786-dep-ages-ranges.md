- **The bake-time dependency gate checks a range at the version bun.lock
  resolves it to.** `node scripts/check-dep-ages.mjs` age-checks ranged entries
  in `dependencies`, `devDependencies`, `optionalDependencies` and `overrides`
  — root and every workspace package.json — against the same minimum release
  age and keep-current list as exact pins. An `npm:` alias range is checked at
  the version installed under the alias. A top-level override range is checked
  at every installed copy of its package, a nested one at the copies installed
  below its enclosing packages; an override range with no installed copy in
  that scope is listed, with nothing to check. A range the gate cannot resolve
  fails the gate; a fresh resolved version is reported with its publish date.
  A `devDependencies` entry the gate refuses (a dist-tag such as `latest`, a
  `v`-prefixed version, surrounding whitespace), a non-string specifier or a
  non-object `devDependencies` value fails the gate, naming the manifest and
  the field, as in `dependencies` and `optionalDependencies`.
  Exact pins are checked as before; exact `devDependencies` pins are still not
  checked.
  Non-empty or malformed `resolutions` in root or workspace manifests are refused.
  `--ci` refuses `FLAIR_DEP_MIN_AGE_DAYS` and `FLAIR_DEP_KEEP_CURRENT` when set;
  local runs without `--ci` retain both knobs.
