- **Adapters that build their own Memory request paths encode the id, and refuse a "." / ".." id.**
  The ADK Python and JS update fallbacks, the flair-mcp continuity capture hook and adapter tools, the bridges importer, the OpenClaw supersede write, the Hermes store, and flair-bench ingestion send Memory ids as one percent-encoded path segment; flair-client does the same for Memory and Relationship requests.
  So an id with reserved URL characters addresses exactly that record, and where the request is signed the signature covers the same encoded path that is sent.
  The signed request joins its route onto the base URL's own path with exactly one slash, so a base that ends in `/` still sends one slash and a base that carries a path keeps it (the request reaches `/flair/Memory/<id>`, not `/Memory/<id>`), and the signed path is the path that leaves the process.
  Every one of these sites — flair-client included — also refuses an id that is exactly `.` or `..` before any request: percent-encoding leaves those unchanged and URL normalization would collapse the segment, so such an id does not address its record.

  (Refs #1970)
