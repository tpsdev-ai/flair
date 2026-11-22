- **The workspace lockfile resolves ip-address 10.7.4 and fastify 5.12.7, outside the vulnerable ranges of GHSA-rxp7-6hxx-x8q5 and GHSA-389g-gv7q-r4x8.**
  The root `overrides` entries move `ip-address` from ^10.5.1 to ^10.7.4 and `fastify`
  from ^5.12.5 to ^5.12.7. An npm install of the `@tpsdev-ai/flair` package packed from
  this change includes no `ip-address`. It still resolves the fastify 5.12.5 that
  harper's installed tree ships as a bundled copy, until flair moves to a harper
  release whose installed tree resolves fastify 5.12.6 or later. Nothing to do on upgrade.
