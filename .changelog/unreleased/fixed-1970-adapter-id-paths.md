- **Adapters that build their own Memory request paths percent-encode the id.**
  The ADK Python and JS memory services' update fallback, the flair-mcp continuity capture hook and adapter tools, and the bridges importer send a Memory id as one encoded path segment, as flair-client does since #1969, so an id with reserved URL characters addresses exactly that record.

  (Refs #1970)
