- **`/mcp` now caps the request body at 256 KB.** The handler read the entire
  request into memory with no limit, and Harper imposes none on this path —
  `srv.http()` bypasses both Fastify's 1 GB `bodyLimit` and the contentTypes
  handler's configurable default. Enforcement is two-phase: an oversized
  `Content-Length` is rejected before a byte is read, and the streaming read
  aborts mid-body, so a chunked request that omits or understates the header
  cannot bypass it. This matters more here than the same pattern elsewhere
  because `/mcp` is the first surface reachable by an open population of OAuth
  clients rather than by agents we issued credentials to.
