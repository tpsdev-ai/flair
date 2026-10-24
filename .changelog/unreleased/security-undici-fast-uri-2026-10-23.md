- **The workspace lockfile resolves undici 8.12.2 and fast-uri 4.2.3, outside the vulnerable ranges of seven advisories published 2026-10-23.**
  The root `overrides` entries move `undici` from `~8.10.2` to an exact `8.12.2`
  (fixing GHSA-xjj6-f33q-929c, high, and GHSA-4qv8-2p9j-2685 and
  GHSA-f72v-6w45-q472, moderate) and `fast-uri` from `^4.1.5` to `4.2.3`
  (fixing GHSA-w74x-v6f9-j3xg and GHSA-wjr9-j795-jxcr, moderate, and
  GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp, low); `bun.lock` moves from
  undici 8.10.2 to 8.12.2 and from fast-uri 4.2.1 to 4.2.3.
  `.github/dep-age-allowlist.json` carries a dated exemption for fast-uri 4.2.3,
  published 2026-10-19, inside the 7-day bake window; the exemption expires
  2026-10-27, after 4.2.3 reaches the bake age. An npm install of the
  `@tpsdev-ai/flair` package still resolves the fast-uri 3.1.0 and 4.2.1 that
  harper 5.3.1's npm-shrinkwrap pins, so four new `vendor-pinned` audit entries cover
  these advisories until flair moves to a harper release whose installed tree
  resolves fast-uri 3.1.9 (3.x) and 4.2.3 (4.x).
