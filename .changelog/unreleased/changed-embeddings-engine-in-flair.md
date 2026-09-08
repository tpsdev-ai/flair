- **The embedding engine now ships inside Flair.** The local GGUF/llama.cpp
  embedding engine that produces Flair's semantic-search vectors moved from the
  external `harper-fabric-embeddings` package into Flair's own tree. Behaviour is
  unchanged and byte-for-byte identical — same nomic model, same `mean` pooling,
  same `search_document:`/`search_query:` prefixes — so existing stored
  embeddings still match. Nothing is written to `harper-config.yaml`; the backend
  still registers in-process on every boot, and semantic search still degrades to
  keyword-only when no native addon is available. Operators need do nothing.

  Packaging: `harper-fabric-embeddings` is removed from dependencies, and the
  seven `@node-llama-cpp/*` platform binaries it used to carry are now Flair's own
  exact-pinned `optionalDependencies` — a host installs only the one binary that
  matches its platform, so the installed footprint is unchanged.
