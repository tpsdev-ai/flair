- **`memory_store` on the server's built-in `/mcp` endpoint can set `visibility`.**
  The tool had no visibility argument of any kind, and sends `durability:
  "standard"` when the caller names none — so every memory written through that
  surface was stamped `private` with nothing the caller could pass to change it.
  An agent wired to the built-in endpoint could not write a memory another agent
  was able to read, while the stdio adapter `@tpsdev-ai/flair-mcp` exposed the
  argument all along. Pass `visibility: "private" | "shared"`; omit it and the
  durability-keyed default applies exactly as before.

  Only those two values are accepted — anything else fails the tool call rather
  than reaching the record. Visibility is a free-form string in the schema and
  the read scope tests it by exact match against `private`, so any other value,
  a typo included, reads as non-private and goes to every agent on the instance.
  Passing an unrecognised value through would write a memory the caller believes
  is owner-only that everyone can read, and silently dropping it would fall back
  to a default that is `shared` for a durable write. A misspelled argument must
  not widen who can read a memory.
