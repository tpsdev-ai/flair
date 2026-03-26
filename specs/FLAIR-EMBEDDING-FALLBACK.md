# Flair Embedding Fallback Cleanup — Spec

**Issue:** #165 (hash-based embedding fallback provides no semantic quality)  
**Priority:** P1  
**Author:** Flint  

## Problem

`resources/embeddings.ts` contains a hash-based `fallbackEmbed()` function that maps text to a 512-dim vector using character hashing. This provides zero semantic quality — it's essentially a sparse bag-of-words hash that can't distinguish "happy dog" from "joyful puppy."

The file is **dead code** — nothing imports `fallbackEmbed`. The actual embedding provider (`embeddings-provider.ts`) returns `null` on failure, and `SemanticSearch` falls back to keyword-only matching.

The problem: keyword-only matching with a 0.05 score cap means search quality degrades dramatically when embeddings are unavailable, and there's no visibility into when this happens.

## Solution

### 1. Remove Dead Code
Delete `resources/embeddings.ts` entirely. The `fallbackEmbed` function is unused and misleading.

### 2. Add Observability to Embedding Failures

In `embeddings-provider.ts`:
- Log a **single warning** (not per-request) when `ensureInit()` fails: `[embeddings] WARN: native embeddings unavailable, falling back to keyword-only search`
- Track init state with a tri-state: `uninitialized | ready | failed`
- Expose a `getStatus()` function returning `{ mode: "local" | "none", initError?: string }`

### 3. Surface in Status Endpoint

In `flair status` CLI output and the `/Health` or `/Status` API response, include:
```json
{
  "embeddings": {
    "mode": "local",
    "model": "nomic-embed-text-v1.5",
    "dims": 768
  }
}
```

Or when failed:
```json
{
  "embeddings": {
    "mode": "none",
    "error": "Failed to load native binary: ..."
  }
}
```

### 4. Return Degradation Warning in Search Results

When `SemanticSearch` falls back to keyword-only, include a `_warning` field:
```json
{
  "results": [...],
  "_warning": "semantic search unavailable — results are keyword-only"
}
```

This lets callers (like BootstrapMemories) surface the degradation to agents.

## Files Changed

- `resources/embeddings.ts` — **DELETE**
- `resources/embeddings-provider.ts` — add status tracking, single warning log
- `resources/SemanticSearch.ts` — add `_warning` when in keyword-only mode
- `src/cli.ts` (status command) — surface embedding status

## Testing

- With working embeddings: no warning, status shows `mode: "local"`
- With broken/missing native binary: warning logged once, status shows `mode: "none"`, search results include `_warning`
- No imports of deleted `embeddings.ts` anywhere

## Risk

Very low. Removing dead code + adding observability. No behavior change for working installations. Degraded installations get better visibility instead of silent failure.
