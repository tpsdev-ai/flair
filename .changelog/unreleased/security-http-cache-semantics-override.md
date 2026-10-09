- **The workspace lockfile resolves http-cache-semantics 4.3.0, outside the vulnerable range of GHSA-ch52-4w7c-c8xp (<=4.2.0).** A root
  `overrides` entry sets the floor, and the advisory's dated audit-allowlist
  entry is removed. Installs of the published `@tpsdev-ai/flair` package do not
  include http-cache-semantics.
