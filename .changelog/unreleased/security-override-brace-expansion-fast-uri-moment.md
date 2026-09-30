- **Root dependency overrides for brace-expansion, fast-uri and moment move the repo lockfile out of their advisories' affected ranges.**
  `brace-expansion` ^5.0.12 (GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr),
  `fast-uri` ^4.1.5 (GHSA-hrr3-gc8f-f4qj, GHSA-jvvf-x445-j334) and `moment` ^2.31.0
  (GHSA-4p3w-j4w9-5jqw) resolve patched versions in `bun.lock`. npm installs still carry harper's
  npm-shrinkwrap pins (brace-expansion 5.0.4, fast-uri 3.1.0 and 4.1.2, moment 2.30.1), so
  GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr, GHSA-hrr3-gc8f-f4qj and
  GHSA-4p3w-j4w9-5jqw stay allowlisted as harper-pinned until the harper release Flair depends
  on resolves patched versions. Flair's own code imports none of these packages. Nothing to do on
  upgrade.
