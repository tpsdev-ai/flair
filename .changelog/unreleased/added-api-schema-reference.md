- **API/schema reference.** New [`docs/api-reference.md`](docs/api-reference.md)
  catalogs HTTP endpoints, auth per resource, and the Presence / Memory / Soul /
  Agent / Federation schemas (plus the other `@table` types). The docs-freshness
  gate now fails if a GraphQL table is missing from that catalog, so it cannot
  rot the way #617 found.
