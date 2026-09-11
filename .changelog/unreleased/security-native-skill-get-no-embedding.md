- **Native `/mcp` `skill_get` never returns the embedding vector.** The
  handler used to honor `includeEmbedding: true` by returning the raw Memory
  record, which bypassed `stripInternalFields`. Nothing in the skill_get
  contract needs the vector, so the flag is gone and the strip is unconditional
  (flair#1593). `memory_get` keeps its documented opt-in (flair#1188).
