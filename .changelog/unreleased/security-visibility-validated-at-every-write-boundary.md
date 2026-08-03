- **A misspelled `visibility` no longer writes a memory everyone can read.** `PUT /Memory/<id>` with
  `{"visibility":"prvate"}` was accepted, and the read scope resolves visibility by exact match on
  `private` — so the typo, a wrong case, or a retired tier like `office` all read as non-private and
  were visible to every agent on the instance. flair#1006 closed this at the CLI flag and the MCP
  tool argument; REST and the in-process API reach `Memory.put()`/`post()` without passing either.

  Both now refuse an unrecognised value with `400 invalid_visibility`, naming the two valid values
  and how to opt out. Refusing rather than dropping the key is deliberate: dropping it falls through
  to the durability-keyed default, which for a permanent or persistent write is `shared` — the same
  widening, arrived at silently.

  **The read predicate is deliberately left permissive.** A row written before the field existed has
  no visibility and must keep reading exactly as it always did. So write-validation is strictly
  stronger than read-resolution, and the two must not be collapsed into one predicate — there is a
  test whose only job is to fail if someone tries.
