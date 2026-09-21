- **The canary verdict script runs on stock macOS bash and treats an unreadable release manifest as fatal.**

  `scripts/ci/canary-verdict.sh` is bash-3.2-safe (no `declare -A`, no
  `mapfile`), so the macOS canary leg and a local run under stock `/bin/bash`
  both produce the block instead of a `declare: -A: invalid option` and 0 bytes;
  a shell older than 3.2 fails fast with a clear message rather than a feature
  syntax error. The lockstep package list now treats a manifest that EXISTS but
  cannot be read or parsed as fatal (DID NOT RUN, naming the path) instead of a
  silent partial set, so the canary can never hash, promote or deprecate an
  incomplete list. `registry-tarball-sha256.mjs` accepts a legal prerelease such
  as `1.2.3-rc-1` (its hand-rolled regex refused it), and a duplicate sha256
  binding is rejected by name.

  (Refs #1781)
