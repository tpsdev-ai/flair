- **The direct client writers never lower a pin, never overwrite a range/tag/unsupported spec, and refuse to write when the CLI cannot read its own version.**

  `flair init` (into `~/.claude.json`) and the JSON, Codex-TOML and pi writers
  used to ask only "does the entry carry the running CLI's spec?" and, on any
  mismatch, overwrote it — direction-blind. A CLI older than the config it
  found (a downgrade, a config shared between installs, a hand-pinned newer
  version) silently replaced a higher pin with a lower one, and a `@^0.55.0`
  range, a `@latest` tag or a `file:` source was treated as merely stale and
  rewritten. Each writer now reads the existing entry through the wiring-spec
  model and compares it with the running CLI's version through the one
  never-lower guard (`src/lib/pin-write-guard.ts`): an AHEAD pin is held with
  its bytes untouched, and the reason — the entry, the pinned version and the
  running version — is named; a BEHIND pin is re-pinned up; an unpinned entry
  is pinned to the running CLI; and a range/tag/unsupported/malformed spec is
  held exactly as written.

  > **Heads-up:** a run whose own version cannot be read now refuses to write
  > rather than falling back to the unpinned spec. An unreadable version means
  > a broken install, and quietly replacing a pin with nothing is the downgrade
  > this change exists to stop. The same refusal also declines a legitimate
  > FIRST install on a fresh home — nothing is created — until the version can
  > be read again.

  (Refs #1778)
