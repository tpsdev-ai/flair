- **Asset blob table.** Agents can store owner-scoped image bytes (screenshots)
  on the hub as Harper Blobs, linked to a Memory. Writes reject decoded
  payloads over 10 MiB and non-image MIME types (XML/SVG subtypes included).
  No MCP or federation surface in this slice.
