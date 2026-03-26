# Flair Re-embedding Migration — Spec

**Issue:** #166  
**Priority:** P2  
**Author:** Flint  

## Problem

Embeddings are generated at write time and stored with each memory record. If the embedding model changes (e.g. nomic-embed-text-v1.5 → v2, or switching to a different model), existing memories retain their old embeddings. Cosine similarity between vectors from different models is meaningless — search quality degrades silently.

There's no mechanism to detect stale embeddings or re-embed existing memories.

## Solution

### 1. Track Embedding Model Version

Add a field to Memory records:

```
embeddingModel: string  // e.g. "nomic-embed-text-v1.5-Q4_K_M"
```

Set this on every write (post/put) in `Memory.ts`:
```typescript
if (vec) {
  content.embedding = vec;
  content.embeddingModel = getModelId();  // from embeddings-provider.ts
}
```

Add `getModelId()` to `embeddings-provider.ts`:
```typescript
export function getModelId(): string {
  return "nomic-embed-text-v1.5-Q4_K_M";  // hardcoded for now, configurable later
}
```

### 2. CLI Command: `flair reembed`

New command that re-generates embeddings for memories with stale or missing model tags:

```bash
# Re-embed all memories for an agent
flair reembed --agent mybot

# Re-embed only stale (different model) memories
flair reembed --agent mybot --stale-only

# Dry run — show count without modifying
flair reembed --agent mybot --dry-run
```

Implementation:
1. Fetch all Memory records for the agent
2. Filter to records where `embeddingModel` is missing or doesn't match current model
3. For each record, regenerate embedding from `content` field
4. Update record with new embedding + embeddingModel tag
5. Rate limit: process N records per second to avoid overloading the embedding engine
6. Print progress: `Re-embedded 150/300 memories...`

### 3. Startup Check

On Flair init or status, compare the current model ID against a sample of stored memories. If mismatch detected, print a warning:

```
⚠️  Embedding model mismatch detected: 42 memories use nomic-embed-text-v1 but current model is nomic-embed-text-v1.5-Q4_K_M
   Run: flair reembed --agent <id> --stale-only
```

## Files Changed

- `resources/embeddings-provider.ts` — add `getModelId()`
- `resources/Memory.ts` — stamp `embeddingModel` on writes
- `schemas/Memory.graphql` — add `embeddingModel: String` field
- `src/cli.ts` — new `reembed` command
- `src/cli.ts` (status) — stale embedding warning

## Testing

- New memories get `embeddingModel` stamped
- `flair reembed --dry-run` reports count without modifying
- `flair reembed --stale-only` only touches records with wrong/missing model tag
- Status command warns when stale embeddings detected

## Risk

Low-medium. The `reembed` command mutates data but is idempotent and user-initiated. The model stamping on writes is additive (new field). Biggest risk is the reembed command taking too long on large memory sets — mitigated by rate limiting and progress output.
