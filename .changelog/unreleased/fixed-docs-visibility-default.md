- **The docs said reads are open unless you opt out; a bare write is `private`.**
  `docs/quickstart.md` told a first-time reader that `flair memory add
  --visibility private` was how to keep a memory owner-only and that "reads are
  otherwise open to every agent on the instance". Reads within an instance
  genuinely are open — for `shared` memories. But visibility is stamped at write
  time from durability (`permanent`/`persistent` -> `shared`,
  `standard`/`ephemeral` -> `private`), and a write naming no durability is
  `standard`, so the bare write the quickstart demonstrates lands `private`. The
  rule appeared in `flair memory add --help` and nowhere in the documentation
  tree at all.

  The quickstart now names the visibility at the moment of the first write,
  gives the durability rule as a table, and shows `--visibility shared` as the
  one-flag way to share on purpose. `README.md`, `SECURITY.md`, `DESIGN.md`,
  `docs/mcp-clients.md`, `docs/the-team.md` and `docs/troubleshooting.md` carried
  the same "private is opt-in" implicature and now state the rule. No behaviour
  changed: private-by-default for non-durable writes is the intended design, and
  the documentation is what was wrong.
