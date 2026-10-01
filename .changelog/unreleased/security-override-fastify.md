- **A raised root dependency override for fastify moves the repo lockfile out of the affected ranges of five fastify advisories published 2026-09-30.**
  `fastify` ^5.12.5 resolves 5.12.5 in `bun.lock` (GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58,
  GHSA-p68q-wchp-6fh7, GHSA-667r-xxjv-c9mm, GHSA-4mh8-r7rc-xpvc). npm installs still carry harper
  5.2.8's npm-shrinkwrap pin (fastify 5.11.3), so all five stay allowlisted as harper-pinned until
  the harper release Flair depends on resolves a fixed version. Nothing to do on upgrade.
