- **qs overridden to ^6.16.0, fast-uri to ^4.1.3, fastify to ^5.12.1 (eight advisories published 2026-09-02).**
  qs GHSA-4mjr-xmp4-gh2g / GHSA-x5fp-wj9c-mxmx (moderate: DoS via attacker-controlled
  isBuffer, array-limit bypass) reach the tree through express and body-parser; fast-uri
  GHSA-5jgf-p345-68v8 / GHSA-f65p-4m7j-42xc / GHSA-fph4-wmhf-6fwf / GHSA-jqff-g426-hqxp
  (high: host confusion and SSRF via IDN, IPv6 and percent-encoded scheme handling) and
  fastify GHSA-3m5p-2c4r-xxw2 / GHSA-w2qp-rph6-63g4 (moderate: X-Forwarded-* spoofing
  under trustProxy hop count, schema-validation bypass via root primitive coercion) reach
  it through harper's pinned server. All three fixes are published and inside the ranges
  the dependants declare (harper 5.2.7 declares fastify ^5.8.2), so the root `overrides`
  entries move them to the fixed lines with no allowlist entry. Nothing to do on upgrade.
