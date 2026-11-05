- **The node-forge 1.4.2 and joi 17.13.9 bake-time exemptions are removed: both pins are now past the 7-day window and pass the gate unexempted (flair#2892).**
  `.github/dep-age-allowlist.json` has no entries. The root `overrides` pins of
  node-forge 1.4.2 and joi 17.13.9, added for the Dependency Audit advisories
  listed in #2892, stay, and the gate now age-checks them like any other exact
  override.
