- **adk-flair-js: `customMetadata` parity with the Python package —
  store-and-return + caps + `subject` + `listMemories()`** (flair#1335,
  mirroring flair#1332/#1333 via #1334; design flair#1202). The JS adapter no
  longer warn-drops `customMetadata`: `addMemory()`/`addEventsToMemory()`
  serialize it into the client-writable `Memory.metadata` JSON blob —
  store-and-return only, exactly ADK's contract: the blob is opaque to the
  server and no key in it has any server-side effect (contract-tested live:
  `{"visibility":"shared"}` in the blob leaves the record private, with a
  positive control through the new explicit knobs). Caps reject with an
  `Error`, never truncate: 64KB serialized, nesting ≤ 16, ≤ 512 keys;
  non-serializable values skip that key with a warning. `subject` (≤ 512
  chars, explicit `addMemory` option authoritative over
  `customMetadata["subject"]`, never auto-extracted) is promoted to the
  record's indexed `subject` column. `searchMemory()` opts into
  `/SemanticSearch`'s `includeMetadata` flag and returns `FlairMemoryEntry`
  objects carrying `customMetadata` (malformed blobs fail soft to `{}` with a
  warning naming the record id), the record `id`, and the top-level `subject`
  — surfaced BOTH as `entry.subject` and `customMetadata["subject"]` (column
  authoritative), since `@google/adk`'s `MemoryEntry` is a plain-object
  interface; the `customMetadata` channel keeps the return shape identical to
  the Python package. `author`/`timestamp` now derive from the record's
  `agentId`/`createdAt` (previously read fields Flair never projects — both
  were always `undefined`). New `listMemories(appName, userId, {limit≤200,
  offset})` pages memories newest-first with the full projection, scoped by
  compound tag + agent identity, both pushed down and re-verified client-side;
  transport errors propagate (browsing must distinguish "no memories" from
  "Flair is down"). `addMemory()` also gains the Python package's explicit
  `durability`/`visibility` options (flair#1234 parity, required by the
  contract test's positive control) and its deterministic record ids
  (`entry.id`, else content SHA-256 prefix — re-adds replace, not duplicate).
  Creates now ride `POST /Memory/` with a 409→`PUT` fallback (flair#1336
  parity via #1339) — the old PUT-shaped create 404s on hosted Harper Fabric
  deployments where PUT is update-only.
