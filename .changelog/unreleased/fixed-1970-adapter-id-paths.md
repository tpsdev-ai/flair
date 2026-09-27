- **Adapters that build their own Memory request paths encode the id, and refuse a "." / ".." id.**
  The ADK Python and JS memory services' update fallback, the flair-mcp
  continuity capture hook and adapter tools, the bridges importer, the OpenClaw
  supersede write, and the Hermes store send a Memory id as one percent-encoded
  path segment, as flair-client's Memory and Relationship calls already do, so an
  id with reserved URL characters addresses exactly that record. Where the
  request is signed, the signature covers the same encoded path that is sent.
  Every one of these sites — flair-client included — also refuses an id that is
  exactly `.` or `..` before any request: percent-encoding leaves those
  unchanged and URL normalization would collapse the segment, so such an id does
  not address its record.

  (Refs #1970)
