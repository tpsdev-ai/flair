- **flair-mcp `skill_get` never returns the embedding vector.** The stdio
  adapter used to honor `includeEmbedding: true` by returning the raw Memory
  record, which bypassed `stripInternalMemoryFields`. Nothing in the skill_get
  contract needs the vector, so the flag is gone and the strip is unconditional
  (flair#1579).
