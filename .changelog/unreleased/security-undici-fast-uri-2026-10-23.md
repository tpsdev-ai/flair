- **The workspace lockfile resolves undici 8.12.2 and fast-uri 4.2.3, outside the vulnerable ranges of seven advisories published 2026-10-23.**
  The root `overrides` entries move the Bun-resolved `undici` from `~8.10.2` to an
  exact `8.12.2` (outside GHSA-xjj6-f33q-929c, high, and GHSA-4qv8-2p9j-2685 and
  GHSA-f72v-6w45-q472, moderate) and the Bun-resolved `fast-uri` from `^4.1.5` to
  `4.2.3` (outside GHSA-w74x-v6f9-j3xg and GHSA-wjr9-j795-jxcr, moderate, and
  GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp, low); `bun.lock` moves from
  undici 8.10.2 to 8.12.2 and from fast-uri 4.2.1 to 4.2.3.
  `.github/dep-age-allowlist.json` carries a dated exemption for fast-uri 4.2.3,
  published 2026-10-19, inside the 7-day bake window; the exemption expires
  2026-10-27, after 4.2.3 reaches the bake age. An npm install of the
  `@tpsdev-ai/flair` package still resolves the fast-uri 3.1.0 and 4.2.1 that
  harper 5.3.1's npm-shrinkwrap pins, so the four fast-uri advisories remain for
  those copies: four new `vendor-pinned` audit entries cover them and expire
  2026-11-02, and an entry is retired earlier when flair moves to a harper release
  whose installed tree resolves fast-uri at least 3.1.9 on 3.x and at least 4.2.3
  on 4.x.
