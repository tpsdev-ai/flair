- **The pin refresh fails closed on a pin it cannot compare, and `flair doctor` reports an unparseable pin instead of calling it stale.**

  A hook or client pin that is not strict semver — e.g. `0.55.1.rc`, `"1.2"`, or
  a hand-edited value, exactly what `semver.valid` rejects — passed the
  never-lower guard and was OVERWRITTEN with the running CLI's version, and
  `flair doctor` rendered it as a stale "OLD adapter" error routed to `--fix`.
  (Prerelease-shaped pins such as `0.55.1-rc.1` or `0.55.1-nightly.20260921` ARE
  strict semver and compare normally.) The guard's decision now fails closed: any
  write it cannot PROVE is not a lowering — including one it cannot compare at
  all — is held, so an unreadable pin is never rewritten. `pinDirection` stays
  three-valued, and `unknown` is its own finding — a non-blocking warning on BOTH
  surfaces (the SessionStart hook in doctor's output, and the MCP-server pin in
  the install-health catalog's mcp-block check) — that names the raw value, is
  never auto-re-pinned, and is never worded as an old adapter. `behind` (stale
  error, re-pin) and `ahead` (held pass) are unchanged.

  (Refs #1778)
