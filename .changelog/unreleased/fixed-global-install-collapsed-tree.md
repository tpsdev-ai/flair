- **`npm install -g @tpsdev-ai/flair` is fixed: 0.54.1 shipped a collapsed
  dependency tree whose Harper engine could not start.**

  `npm install -g @tpsdev-ai/flair@0.54.1` exited 0 but installed 50 packages
  instead of 543 (the 0.53.0 count), logged `invalid or damaged lockfile` eight
  times, and left `harper` with no dependency tree at all — `node
  harper.js version` threw. The cause was 0.54.1's `bundleDependencies:
  ["@tpsdev-ai/flair-tool-descriptors"]`, which made npm's reify give up on
  harper's own `npm-shrinkwrap.json`.

  The descriptors are no longer a dependency, bundled or otherwise: they are
  copied into each consuming package's source tree at build time
  (`resources/tool-descriptors/` for `flair`,
  `packages/flair-mcp/src/tool-descriptors/` for `flair-mcp`) and imported by
  relative path, so nothing about the install depends on the private descriptor
  package any more.

  A new CI lane global-installs the packed tarball on every pull request and
  fails on any of the four symptoms above, so an install that cannot start its
  engine can no longer go green (Refs #1683, #1681, #1684).

  > **Heads-up:** do not install `@tpsdev-ai/flair@0.54.1` into a global prefix.
  > Installing the next release replaces the broken tree in place; no manual
  > cleanup is needed.
