- **The handlebars 4.7.10 bake-time exemption is removed: the pin is now past the 7-day window and passes the gate unexempted (flair#2424).**
  `.github/dep-age-allowlist.json` has no entries. The root `overrides` pin of
  handlebars 4.7.10, the first release patched for GHSA-8r5x-fm3f-whwj,
  GHSA-p8wg-vrv2-v86f and GHSA-xw65-4hp5-5hc7, stays, and the gate now
  age-checks it like any other exact override.
