- **The workspace resolves body-parser 2.4.0, outside the vulnerable range of GHSA-27r3-jxmh-p828.**
  A root `overrides` entry pins body-parser 2.4.0 (express 5.2.1, its only
  consumer here, accepts `^2.2.1`), and `.github/dep-age-allowlist.json` carries
  a dated exemption because 2.4.0 was published 2026-10-22, inside the 7-day bake
  window; the exemption expires 2026-10-30, after 2.4.0 reaches the bake age.
