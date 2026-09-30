- **Root dependency overrides raised for undici, ip-address, lodash, joi and fast-uri advisories in the repo lockfile.**
  `undici` ~8.10.2 (GHSA-3wwx-pv8p-q78v), `ip-address` ^10.5.1 (GHSA-rpw4-54j3-4h4q,
  GHSA-2vr4-cq9g-pvrc) and `lodash` ^4.18.0 (GHSA-r5fr-rjxr-66jc, GHSA-xxjr-mmjv-4gpg,
  GHSA-f23m-r3pf-42rh) move `bun.lock` out of the affected ranges, and the three lodash
  audit-allowlist entries are retired. `joi` ^17.13.7 and `fast-uri` ^4.1.4 do the same for
  `bun.lock` only: npm installs still carry harper's npm-shrinkwrap pins, so
  GHSA-6w3j-5fw6-r9vr, GHSA-gg4h-3hg2-grpc, GHSA-6h2x-m376-mqjq and the new GHSA-qw65-cvwx-89v3 stay allowlisted as
  harper-pinned until harper updates its shrinkwrap. Flair's own code imports none of these
  packages. Nothing to do on upgrade.
