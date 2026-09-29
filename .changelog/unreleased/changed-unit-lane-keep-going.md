- **The unit lane now runs every step in CI and reports all failures at once, instead of stopping at the first.**
  `scripts/test-unit.ts` gained a keep-going mode: it runs every step, prints one
  final summary listing each failed step with its exit status, and exits non-zero
  if any step failed. It is on by default when `CI` is set (GitHub Actions sets
  it), and available locally with `bun run test:unit --keep-going`; a local run
  without the flag keeps the fail-fast behaviour and stops at the first failing
  step. The home-isolation and temp-leak guards run once at the end in either
  mode, and a guard failure is listed in the same summary, so it still fails the
  lane even when every step passed.

  (Closes #2030)
