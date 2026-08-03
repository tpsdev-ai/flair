- **Seven advisories resolved by pinning three transitive dependencies forward.** A wave of
  advisories published on 2026-08-03 took the dependency gate from one blocking entry to seven, and
  five of them were the same package:

  | package | advisories | worst |
  |---|---|---|
  | `undici` → `^8.9.0` | 5 | **high** — cross-user information disclosure |
  | `brace-expansion` → `^5.0.9` | 1 | **high** — DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation |
  | `fast-uri` → `^4.1.2` | 1 | **high** — host confusion via backslash |

  All three reach us transitively — through `pi-coding-agent`, `openclaw`, and
  `harper › @fastify/static › glob › minimatch` — so none could be fixed by changing a direct
  dependency. Total advisories drop from 21 to 14, and every remaining one is allowlisted with a
  dated justification.

  These are plain version overrides, deliberately **not** `npm:` aliases. flair#750 records an alias
  override (`harper` → `npm:@harperfast/harper@…`) that collided with the already-installed scoped
  copy, left npm's tree `invalid`, and made any second npm operation fail — which broke the clean-VM
  install gate and was reverted. A version constraint introduces no second package name, so that
  failure mode is absent by construction. Verified: build, a second `bun install` against the
  reified tree, and the full unit suite (3859 tests) all pass.

  Worth stating for whoever revisits these: an override is a **forward pin, not a fix**. Each one is
  correct only until the upstream dependency resolves the advisory itself, at which point the
  override becomes a pin holding a version we no longer need to hold. Re-check them at each
  dependency bump rather than treating them as settled.
