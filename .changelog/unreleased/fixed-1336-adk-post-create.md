- **adk-flair: creates now use `POST /Memory/` (the create verb) instead of
  `PUT /Memory/{id}`, with a 409 → PUT fallback for re-ingestion; `Memory`
  `post()` gains createdAt parity with `put()`** (flair#1336). All three write
  entrypoints (`add_session_to_memory`, `add_events_to_memory`, `add_memory`)
  previously created records via `PUT /Memory/{id}` — update-only on some
  hosted Harper Fabric deployments, where a PUT-shaped create 404s and every
  adk-flair write fails (not reproducible on stock Harper 5.2.0/5.2.2/5.2.4,
  where PUT upserts). Creates go through `POST /Memory/` with the id in the
  body; a 409 (record already exists — deterministic-id re-ingestion of a
  growing session) falls back to `PUT /Memory/{id}`, preserving the old
  replace/refresh semantics. HTTP failures now raise `FlairRequestError`
  (a `RuntimeError` subclass, message unchanged) carrying `.status_code` —
  the write-path warning logs that used to print the undiagnosable
  `status=?` now show the real status. Server side: `Memory.post()` honors a
  caller-supplied `createdAt` exactly as `put()` always has (`?? now`) —
  moving creates onto POST would otherwise silently re-stamp historical
  timestamps (`MemoryEntry.timestamp`) with server-now; `validFrom` follows
  `createdAt`, `updatedAt` stays the true write moment, and the ephemeral
  `expiresAt` stamp remains anchored to write time, so a caller `createdAt`
  cannot move the flair#1257 exposure window. Grants no new capability: PUT
  already accepted arbitrary `createdAt` from the same principals.