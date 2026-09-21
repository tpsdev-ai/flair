- **The canary now emits a sha256-bound promote block for every lockstep package, so `latest` no longer skews on release.**

  The promote step moved `latest` for one of the lockstep packages, so a release
  left `flair` at the new version while `flair-client` / `flair-mcp` / the plugins
  stayed behind — the mismatch `flair#1383` detects at runtime, manufactured by
  the release chain on every release.

  The canary's PASS block is now ONE snippet pasted once, in TWO phases: it
  verifies EVERY package's published-tarball sha256 first (so a registry hiccup
  mid-paste touches no tag), then runs the `npm dist-tag add` lines
  (`@tpsdev-ai/flair` last, so a partial paste never leads with the CLI), then
  the skew check; a missing sha refuses the whole block (all or none). The FAIL
  block prints one `npm deprecate` line per package, the CLI first. A new
  registry-skew check names any `latest` that disagrees, the canary runs it
  before the verdict, and the release docs show the block, the `--otp` form
  under 2FA, and the skew check as the last step. The package list is derived
  once from the manifests — never copied into the verdict script.

  (Refs #1781, #1686, #1383)
