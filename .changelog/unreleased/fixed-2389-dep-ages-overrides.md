- **The bake-time gate now age-checks exact-pinned `overrides` in the root and
  workspace manifests.** A version pinned through an `overrides` entry is
  checked against the 7-day policy like a `dependencies` pin, and an `npm:`
  alias is checked against its target. A fresh security pin can be named with a
  dated entry in `.github/dep-age-allowlist.json`, and an expired entry fails
  the gate (flair#2389).
