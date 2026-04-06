# DistillTribalKnowledge — Cross-Agent Knowledge Synthesis

## Status
- **Owner:** Flint
- **Bead:** ops-130
- **Priority:** P2
- **Depends on:** ops-31.2 (MemoryReflect — shipped)

## Problem

230+ memories across 7 agents, zero cross-pollination. Every agent is a solo brain. MemoryGrant table exists but is empty. No process for extracting organizational knowledge from individual agent experiences.

Agents independently learn the same lessons, hit the same bugs, and make overlapping decisions — but none of them know what the others discovered. The organization has collective intelligence trapped in individual silos.

## Solution: Two-Tier Distillation

### Tier 1: Core (no external dependencies)

Uses existing HNSW embeddings for cross-agent semantic clustering. No LLM, no API key, always available.

#### Harper Resource: `POST /DistillTribalKnowledge`

**Request:**
```json
{
  "agents": ["flint", "kern", "sherlock"],  // required: agents to cross-reference
  "minAgents": 2,          // minimum agents that must agree for consensus (default: 2)
  "minSimilarity": 0.7,    // cosine similarity threshold for clustering (default: 0.7)
  "maxClusters": 20,       // cap on output clusters (default: 20)
  "scope": "all",          // "all" | "recent" | "persistent-only"
  "since": "2026-03-01",   // ISO timestamp lower bound (optional, used with scope=recent)
  "focus": null,           // optional query to bias clustering (e.g. "deployment issues")
  "synthesize": false      // if true, use LLM synthesis (Tier 2)
}
```

**Response:**
```json
{
  "clusters": [
    {
      "id": "cluster-001",
      "theme": "Ed25519 key management across environments",
      "consensusScore": 0.85,
      "agentCount": 3,
      "agents": ["flint", "kern", "sherlock"],
      "memories": [
        {
          "id": "flint-123",
          "agentId": "flint",
          "content": "Key rotation must preserve old public key...",
          "similarity": 0.92
        },
        {
          "id": "kern-456",
          "agentId": "kern",
          "content": "Architecture review: key pair lifecycle needs...",
          "similarity": 0.88
        },
        {
          "id": "sherlock-789",
          "agentId": "sherlock",
          "content": "Security finding: stale keys in production...",
          "similarity": 0.79
        }
      ],
      "contradictions": [],
      "synthesis": null
    }
  ],
  "contradictions": [
    {
      "memoryA": { "id": "flint-111", "agentId": "flint", "content": "Default port should be 9926..." },
      "memoryB": { "id": "kern-222", "agentId": "kern", "content": "Port 19926 avoids conflicts..." },
      "similarity": 0.75,
      "type": "opposing_conclusions"
    }
  ],
  "stats": {
    "totalMemories": 350,
    "memoriesAnalyzed": 280,
    "clustersFound": 12,
    "contradictionsFound": 2,
    "agentsIncluded": 3
  },
  "prompt": null
}
```

#### Algorithm

1. **Collect memories** from all specified agents (via admin auth or cross-agent grants)
2. **Build pairwise similarity matrix** using existing HNSW embeddings (cosine distance)
3. **Cluster by similarity** — greedy agglomerative clustering with `minSimilarity` threshold
4. **Filter for consensus** — keep only clusters where `>= minAgents` different agents contributed
5. **Detect contradictions** — find pairs where agents have high semantic similarity but opposing sentiment or conclusions (heuristic: same topic keywords, different durability/type, or explicit "don't" vs "do" patterns)
6. **Generate theme labels** — extract key terms from cluster centroid's nearest content (no LLM needed; TF-IDF or just the most common significant words)
7. **Score consensus** — `consensusScore = (agentCount / totalAgents) * avgSimilarity * durabilityWeight`

#### Contradiction Detection (Heuristic)

Two memories are flagged as potentially contradictory when:
- Cosine similarity > 0.6 (same topic)
- Different agents
- One of:
  - Opposite durability signals (one ephemeral, one persistent on same topic)
  - Negation patterns in content ("don't do X" vs "always do X")
  - Different `type` fields (one is `decision`, other is `lesson` that contradicts it)

False positives are fine — the goal is to surface for human review, not to auto-resolve.

### Tier 2: Enhanced (optional LLM API key)

When `synthesize: true` is set AND an LLM provider is configured in `~/.flair/config.yaml`:

```yaml
llm:
  provider: openai | anthropic | google | ollama
  model: gpt-4o | claude-sonnet-4-6 | gemini-2.5-flash | qwen3:32b
  apiKey: ${FLAIR_LLM_API_KEY}  # env var or literal
  baseUrl: http://localhost:11434/v1  # for ollama
```

#### What Tier 2 adds:

1. **Natural language theme labels** — LLM names each cluster instead of keyword extraction
2. **Synthesized tribal knowledge** — Each cluster gets a crisp, distilled insight written by the LLM
3. **Decision-outcome linking** — LLM connects decision memories to their outcomes across agents
4. **Contradiction analysis** — LLM explains why two memories conflict and suggests resolution

#### Synthesis prompt template:

```
You are synthesizing organizational knowledge from multiple AI agents.

## Cluster: {theme}
Agents: {agent_list}
Consensus score: {score}

## Memories (from different agents):
{formatted_memories}

## Task
1. Write ONE concise tribal knowledge statement that captures what these agents collectively know.
2. Note any nuance lost in the synthesis.
3. If memories partially conflict, note the tension.

Output format:
INSIGHT: <one paragraph>
NUANCE: <optional, one sentence>
CONFIDENCE: high | medium | low
```

#### Output handling:

Synthesized insights are written as new Memory records with:
- `agentId`: special org-scoped ID (e.g., `org` or configurable)
- `durability`: `persistent`
- `type`: `fact`
- `source`: `tribal-distill`
- `derivedFrom`: array of source memory IDs from the cluster
- `tags`: `["tribal-knowledge", "distilled"]`
- `visibility`: `office` (visible to all agents without explicit grants)

**Critical constraint:** LLM synthesis produces DERIVED artifacts only. Source memories are never modified. Remove the API key → lose synthesis, keep all originals.

### Degraded Mode

| Configuration | What works |
|--------------|-----------|
| No LLM key | Core clustering, consensus scores, keyword themes, contradictions |
| No grants | Admin-only operation (requires admin auth) |
| Single agent | Returns empty clusters (needs ≥2 agents for consensus) |

---

## CLI: `flair distill`

```bash
# Basic cross-agent distillation
flair distill --agents flint,kern,sherlock

# With LLM synthesis
flair distill --agents flint,kern,sherlock --synthesize

# Focused on a topic
flair distill --agents flint,kern,sherlock --focus "deployment"

# Recent memories only
flair distill --agents flint,kern,sherlock --scope recent --since 2026-04-01

# Write results to Flair (not just display)
flair distill --agents flint,kern,sherlock --synthesize --write

# Dry run (show what would be clustered)
flair distill --agents flint,kern,sherlock --dry-run
```

**Output (no --write):** Pretty-printed cluster report to stdout. Human reviews, decides what to keep.

**Output (--write):** Writes synthesized memories to Flair with `source: tribal-distill` tag. Reports IDs of created memories.

---

## Schema Changes

### New field on Memory:
```graphql
visibility: String  # existing field, values: null (private) | "office" (visible to all)
```

Already exists in the schema. Office-visible memories are included in SemanticSearch results for any agent without needing explicit MemoryGrant.

### No new tables needed.

The `source` field on Memory already supports tagging derived records. The `derivedFrom` field links back to source memories. The `visibility: "office"` field handles org-wide access.

---

## Auth & Access

- **Admin mode:** Admin credentials can distill across any agents (no grants needed)
- **Agent mode:** Agent can distill only across agents they have `search` or `read` grants for
- **Grant-based:** `flair grant flint kern --scope search` enables flint to include kern's memories in distillation

This reuses the existing MemoryGrant infrastructure that SemanticSearch already supports.

---

## Bootstrap Integration

BootstrapMemories already includes office-visible memories alongside personal ones. Tribal knowledge records written with `visibility: "office"` will automatically appear in every agent's bootstrap — no additional integration needed.

---

## Implementation Plan

### Phase 1: Core Resource
1. `resources/DistillTribalKnowledge.ts` — Harper custom resource
2. Cross-agent memory collection (admin + grant-based)
3. Pairwise cosine similarity using existing embeddings
4. Greedy agglomerative clustering
5. Consensus scoring
6. Keyword-based theme extraction
7. Contradiction detection (heuristic)

### Phase 2: CLI
8. `flair distill` command in `src/cli.ts`
9. Pretty-print output format
10. `--dry-run` mode

### Phase 3: LLM Synthesis (Tier 2)
11. LLM provider config in `~/.flair/config.yaml`
12. Synthesis prompt + response parsing
13. Memory write path with `source: tribal-distill` + `derivedFrom`
14. `--synthesize` and `--write` CLI flags

### Phase 4: Integration
15. MCP tool: `distill` in flair-mcp
16. Tests: unit (clustering, scoring), integration (multi-agent roundtrip)
17. Documentation: `docs/tribal-knowledge.md`

---

## Success Criteria

- [ ] Cross-agent clusters surfaced with consensus scores (core, no LLM)
- [ ] Contradiction detection surfaces conflicting memories
- [ ] `flair distill` CLI outputs readable cluster report
- [ ] LLM synthesis produces distilled tribal knowledge records (when configured)
- [ ] Distilled records visible to all agents via bootstrap (office visibility)
- [ ] Source memories never modified by distillation
- [ ] Works (degraded) without LLM key — core clustering still valuable
- [ ] Admin auth OR grant-based access — no bypass of agent isolation

---

## References

- ops-31.2: MemoryReflect (single-agent reflection — shipped)
- MemoryConsolidate.ts: promotion/archival heuristics (pattern for evaluate())
- SemanticSearch.ts: cross-agent search via MemoryGrant (reuse for collection)
- Jack Dorsey's "Company World Model" essay — Flair as organizational nervous system
