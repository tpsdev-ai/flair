- **Asset blob table.** Agents can store owner-scoped image bytes (screenshots)
  on the hub as Harper Blobs, linked to a Memory. Writes reject decoded
  payloads over 10 MiB, non-image MIME types (XML/SVG subtypes included), and
  unsized non-string `data` (no fail-open). No MCP or federation surface in
  this slice.

  Orphan blobs are retained until the owning agent deletes the Asset row;
  deleting the parent Memory does not sweep them. `updatedAt` is stamped so a
  later maintenance sweep can key on recency.
