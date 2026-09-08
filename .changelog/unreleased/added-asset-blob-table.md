- **Asset blob table.** Agents can store owner-scoped image bytes (screenshots)
  on the hub as Harper Blobs, linked to a Memory. Writes reject decoded
  payloads over 10 MiB, non-image MIME types (XML/SVG subtypes included), and
  unsized non-string `data` (no fail-open). No MCP or federation surface in
  this slice.

  Orphan blobs are retained until the owning agent deletes the Asset row;
  deleting the parent Memory does not sweep them. Slice 2's serving tool
  returns 404 for dangling memoryIds; the GC sweep lands with that slice.
  `updatedAt` is stamped so that sweep can key on recency. `memoryId`
  exist-and-owned validation is deferred (unvalidated string this slice).
