- **The bake-time gate now age-checks exact versions pinned through `overrides`**
  in the root and workspace manifests, nested rules included, against the
  7-day policy; an `npm:` alias is checked against its target, and an override
  form the gate does not support fails it. A fresh security pin can be named
  with a dated entry in `.github/dep-age-allowlist.json`; an expired or
  malformed entry fails the gate (flair#2389).
