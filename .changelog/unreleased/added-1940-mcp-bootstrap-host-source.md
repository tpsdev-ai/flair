- **Native `/mcp` accepts host-source pointers and renders them in non-admin agent search results; bootstrap cites sources for non-admin agents (flair#1940).**

  Native `/mcp` `memory_store` takes an optional `hostSource`
  (`{ v: 1, host, kind, id, url? }`) plus `hostSourceScope` and `sessionId`; the server
  validates the pointer with the same validator the REST write uses, and a store without them
  is unchanged. For non-admin agents, native `/mcp` search results render a bound
  pointer to a reader allowed to see it, or `withheld` when the reader cannot see it.
  The stdio adapter does not expose these write fields or render sources in search text.
  For a non-admin agent caller, bootstrap cites
  each recalled item that has a visible source, short form `[via <host>/<kind> <id8> (unverified)]`;
  an item with no source renders exactly as before. hostSource is the writer's unverified claim about an external source, stored with the writer's authenticated agent id; Flair does not verify it.
