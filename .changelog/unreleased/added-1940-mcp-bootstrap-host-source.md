- **The MCP `memory_store` tool accepts a host-source pointer, MCP search renders it, and
  bootstrap prose cites it.** `memory_store` takes an optional `hostSource`
  (`{ v: 1, host, kind, id, url? }`) plus `hostSourceScope` and `sessionId`; the server
  validates the pointer with the same validator the REST write uses, and a store without them
  is unchanged. MCP search results render the pointer to a reader allowed to see it, and the
  literal `"withheld"` to a reader who may read the record but not the pointer. For a non-admin agent caller, bootstrap cites
  each recalled item that has a visible source, short form `[via <host>/<kind> <id8> (unverified)]`;
  an item with no source renders exactly as before. hostSource is the writer's unverified claim about an external source, stored with the writer's authenticated agent id; Flair does not verify it.
