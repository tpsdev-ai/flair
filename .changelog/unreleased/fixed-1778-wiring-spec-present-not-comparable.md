- **Wiring specs that are a range, tag or unsupported source are no longer read as absent (and overwritten); they are held as present-but-not-comparable.**

  The shared wiring extractor reported a `@^0.55.0` range, a `@latest` tag, a
  `file:`/`git:` source or a non-canonical token (`v0.55.0`, `1.2.3.4`) as
  `null` — i.e. as if the entry carried no spec at all — and the never-lower
  guard reads `null` as "nothing to protect", so the next write replaced the
  spec with the running CLI's own. A new interim wiring-spec model
  (`src/lib/wiring-spec.ts`) decodes each wiring envelope (`npx -y -p`,
  MCP/TOML args, pi `npm:`, a bare package, the `workspace:` protocol) and
  partitions the spec in six ordered steps; every consumer — the shared
  extractor, `detectWiredFlairMcp`, the owned-pin readers and the pi pin
  reader — now reads it. A concrete version and an unpinned entry are unchanged;
  a range/tag/unsupported/malformed spec is now reported as its raw token, so
  the existing fail-closed guard holds instead of overwriting it.

  (Refs #1778)
