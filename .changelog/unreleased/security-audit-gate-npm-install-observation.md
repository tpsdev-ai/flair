- **The audit gate now audits the npm-installed tarball, not just the bun lockfile.**
  `bun audit` only sees the lockfile, so advisories harper's `npm-shrinkwrap`
  pins (fastify, fast-uri, brace-expansion, find-my-way, picomatch) were
  invisible to the gate. The Install-from-tarball smoke lane now runs a second
  `npm audit --omit=dev` observation, and the gate reports those advisories as
  `FIXED-FOR-BUN-ONLY` — fixed for bun installs, still present under npm until
  harper ships a shrinkwrap resolving them. The allowlist now records which
  source each advisory is observed in, and `release.sh` refuses to cut when a
  changelog fragment claims one of these as fully "fixed".
