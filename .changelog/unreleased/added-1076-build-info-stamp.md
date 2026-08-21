- **The build stamps its own identity, and the running server reports it
  (#1076).** Both build scripts now write `dist/build-info.json` —
  `{ version, commit, builtAt, builder }` — and `/Health` (plus the
  authenticated `/HealthDetail`) gains an additive `buildCommit` field, with
  `version` now served from that stamp rather than `package.json`. The served
  code identifies itself: deploy verification asserts identity directly
  (`grep` the stamp server-side, or `/Health` remotely) instead of hunting a
  fresh dist-grep discriminator every release, and a stale `dist/` can no
  longer masquerade as the version `package.json` claims. Builds outside a
  git work tree (npm tarballs) stamp an honest `"commit": null` — the field
  is never omitted and never fabricated.
