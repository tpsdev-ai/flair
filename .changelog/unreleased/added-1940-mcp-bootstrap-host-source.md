- **The MCP `memory_store` tool accepts a host-source pointer, MCP search renders it, and
  bootstrap prose cites it.** `memory_store` takes an optional `hostSource`
  (`{ v: 1, host, kind, id, url? }`) plus `hostSourceScope` and `sessionId`; the server
  validates the pointer with the same validator the REST write uses, and a store without them
  is unchanged. MCP search results render the pointer to a reader allowed to see it, and the
  literal `"withheld"` to a reader who may read the record but not the pointer. Bootstrap cites
  each recalled item that has a visible source, short form `[via <host>/<kind> <id8> (unverified)]`;
  an item with no source renders exactly as before. A `hostSource` is the writer's claim — a
  claimed external source, not verified host authorship.
