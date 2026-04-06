# DistillTribalKnowledge — Cross-Agent Knowledge Synthesis

## Status
- **Owner:** Flint
- **Bead:** ops-130
- **Priority:** P2
- **Depends on:** ops-31.2 (MemoryReflect — shipped)

## Problem

230+ memories across 7 agents, zero cross-pollination. Every agent is a solo brain. MemoryGrant table exists but is empty. No process for extracting organizational knowledge from individual agent experiences.

Agents independently learn the same lessons, hit the same bugs, and make overlapping decisions — but none of them know what the others discovered.

## Design Principle

**Flair is the data layer, not the intelligence layer.**

Same pattern as MemoryReflect: Flair does the clustering and returns structured data + a synthesis prompt. The *agent* feeds the prompt to its own LLM, reviews the output, and writes insights back. Flair never makes LLM calls. Any agent, any model, any workflow.

This means:
- No LLM config in Flair. No API keys. No provider abstraction.
- Synthesis quality depends on the agent's model — Claude, Gemini, Ollama, whatever.
- HITL is natural — agent proposes, human approves.
- Reprocessing is trivial — run again with different focus, different agent, different model.
- The clustering is deterministic; only the synthesis varies.

---

## Harper Resource: `POST /DistillTribalKnowledge`

### Request
```json
{
  "agents": ["flint", "kern", "sherlock"],
  "minAgents": 2,
  "minSimilarity": 0.7,
  "maxClusters": 20,
  "scope": "all",
  "since": "2026-03-01",
  "focus": "deployment issues"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents` | string[] | required | Agents to cross-reference |
| `minAgents` | number | 2 | Minimum agents in a cluster for consensus |
| `minSimilarity` | number | 0.7 | Cosine similarity threshold for clustering |
| `maxClusters` | number | 20 | Cap on output clusters |
| `scope` | string | "all" | "all" \| "recent" \| "persistent-only" |
| `since` | string | null | ISO timestamp lower bound (with scope=recent) |
| `focus` | string | null | Query to bias clustering toward a topic |

### Response
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
        }
      ]
    }
  ],
  "contradictions": [
    {
      "memoryA": { "id": "flint-111", "agentId": "flint", "content": "..." },
      "memoryB": { "id": "kern-222", "agentId": "kern", "content": "..." },
      "similarity": 0.75,
      "type": "opposing_conclusions"
    }
  ],
  "prompt": "# Tribal Knowledge Synthesis\n...",
  "stats": {
    "totalMemories": 350,
    "memoriesAnalyzed": 280,
    "clustersFound": 12,
    "contradictionsFound": 2,
    "agentsIncluded": 3
  }
}
```

### The `prompt` Field

Like MemoryReflect, the response includes a structured LLM prompt that the calling agent feeds to its own model:

```
# Tribal Knowledge Synthesis

You are synthesizing organizational knowledge from {agentCount} AI agents.

## Clusters
For each cluster below, write ONE concise tribal knowledge statement.

### Cluster 1: {theme} (consensus: {score}, agents: {agents})
{formatted_memories}

### Cluster 2: ...

## Contradictions
For each contradiction, explain the tension and suggest a resolution.

### Contradiction 1:
Agent {a}: "{content_a}"
Agent {b}: "{content_b}"

## Output Format
For each cluster, produce:
- INSIGHT: <one paragraph distilling what the team collectively knows>
- CONFIDENCE: high | medium | low
- ACTION: <optional — what should change based on this insight>
- TAGS: <comma-separated relevant tags>

For each contradiction:
- TENSION: <what's conflicting>
- RESOLUTION: <suggested resolution or "needs human decision">
```

The agent takes this prompt, runs it through its LLM, and decides what to write back to Flair as tribal knowledge memories.

---

## Algorithm

1. **Collect memories** from specified agents
   - Admin auth: can read any agent's memories directly
   - Agent auth: can only read memories from agents with MemoryGrant (scope: search|read)
2. **Optional focus bias** — if `focus` is set, generate a query embedding and pre-filter memories by relevance to the focus topic (cosine similarity > 0.3 against focus embedding)
3. **Build pairwise similarity** — for each pair of memories from *different* agents, compute cosine similarity from existing embeddings
4. **Cluster** — greedy agglomerative clustering:
   - Start with the highest-similarity cross-agent pair as seed
   - Add memories with similarity > `minSimilarity` to the nearest cluster centroid
   - Stop when no unassigned memory has similarity > threshold to any cluster
5. **Filter for consensus** — discard clusters where `< minAgents` different agents contributed
6. **Detect contradictions** — pairs where:
   - Cosine similarity > 0.6 (same topic)
   - Different agents
   - Negation patterns ("don't" vs "always", "avoid" vs "prefer")
   - Or conflicting signals (one ephemeral/archived, one persistent on same topic)
7. **Extract themes** — significant terms from cluster centroid's nearest content (TF-IDF or most common non-stopword terms across cluster members)
8. **Score consensus** — `consensusScore = (agentCount / totalAgents) * avgSimilarity * durabilityWeight`
9. **Build synthesis prompt** — structured prompt for the calling agent's LLM

---

## Agent Workflow

### Without HITL (trusted agent, automated)
```
Agent → POST /DistillTribalKnowledge → clusters + prompt
Agent → LLM(prompt) → proposed insights
Agent → PUT /Memory (for each insight, with source: "tribal-distill", derivedFrom: [...], visibility: "office")
```

### With HITL (human review)
```
Agent → POST /DistillTribalKnowledge → clusters + prompt
Agent → LLM(prompt) → proposed insights
Agent → display proposals to human
Human → approve/reject/edit each
Agent → PUT /Memory (approved only)
```

### Reprocessing
```
Agent → POST /DistillTribalKnowledge (same params) → same clusters (deterministic)
Agent → different LLM or different prompt engineering → refined insights
Agent → PUT /Memory with supersedes: <previous-distill-memory-id>
```

The `supersedes` field on Memory already supports version chains. A re-distillation supersedes the previous one.

---

## Memory Schema for Tribal Knowledge

Distilled memories written by agents use existing fields:

| Field | Value | Purpose |
|-------|-------|---------|
| `agentId` | the synthesizing agent's ID | who did the synthesis |
| `source` | `"tribal-distill"` | marks as derived, not original |
| `derivedFrom` | `["flint-123", "kern-456", ...]` | links to source memories |
| `visibility` | `"office"` | visible to all agents without grants |
| `durability` | `"persistent"` | survives consolidation |
| `type` | `"fact"` or `"lesson"` | standard memory types |
| `tags` | `["tribal-knowledge", ...]` | filterable |
| `supersedes` | previous distill memory ID | for re-distillation |

**No new tables. No new fields.** Everything uses existing Memory schema.

---

## CLI: `flair distill`

```bash
# Show cluster report (human-readable)
flair distill --agents flint,kern,sherlock

# Focused on a topic
flair distill --agents flint,kern,sherlock --focus "deployment"

# Recent memories only
flair distill --agents flint,kern,sherlock --scope recent --since 2026-04-01

# Output as JSON (for piping to an agent)
flair distill --agents flint,kern,sherlock --json

# Dry run — show stats without full clustering
flair distill --agents flint,kern,sherlock --dry-run
```

The CLI does NOT synthesize or write — it only calls the endpoint and displays results. Synthesis and writing are the agent's responsibility.

---

## MCP Tool: `distill`

Added to flair-mcp so agents can call it programmatically:

```json
{
  "name": "distill",
  "description": "Cross-agent knowledge synthesis. Returns clusters of similar memories across agents, contradictions, and a synthesis prompt.",
  "inputSchema": {
    "agents": { "type": "array", "items": { "type": "string" } },
    "focus": { "type": "string" },
    "minAgents": { "type": "number" },
    "scope": { "type": "string" }
  }
}
```

---

## Auth & Access

- **Admin:** Can distill across any agents (no grants needed)
- **Agent:** Can only include agents they have `search` or `read` grants for
- **Grant setup:** `flair grant kern flint --scope search` lets flint read kern's memories for distillation

Reuses existing MemoryGrant + SemanticSearch infrastructure.

---

## Bootstrap Integration

Office-visible memories (`visibility: "office"`) are already included in BootstrapMemories alongside personal memories. Tribal knowledge records appear in every agent's bootstrap automatically — no additional integration needed.

---

## Implementation Plan

### Phase 1: Core Resource
1. `resources/DistillTribalKnowledge.ts` — Harper resource
2. Cross-agent memory collection (admin + grant-based auth)
3. Pairwise cosine similarity from existing embeddings
4. Greedy agglomerative clustering
5. Consensus scoring and filtering
6. Keyword-based theme extraction
7. Contradiction detection (heuristic)
8. Synthesis prompt generation

### Phase 2: CLI
9. `flair distill` command in `src/cli.ts`
10. Pretty-print output format (cluster report)
11. `--json`, `--dry-run` modes

### Phase 3: Integration
12. MCP tool in flair-mcp
13. Tests: unit (clustering algorithm, scoring, contradiction detection), integration (multi-agent roundtrip)
14. Documentation: `docs/tribal-knowledge.md`

---

## Success Criteria

- [ ] Cross-agent clusters surfaced with consensus scores
- [ ] Contradiction detection surfaces conflicting memories
- [ ] Synthesis prompt returned for agent-side LLM processing
- [ ] `flair distill` CLI outputs readable cluster report
- [ ] Agent can write synthesized tribal knowledge as office-visible memories
- [ ] Tribal knowledge appears in all agents' bootstrap
- [ ] Source memories never modified by distillation
- [ ] Admin auth OR grant-based access — no bypass of agent isolation
- [ ] Works without any LLM — core clustering is self-contained
- [ ] Re-distillation uses `supersedes` for version chains

---

## References

- MemoryReflect.ts: single-agent reflection prompt pattern (template for this)
- MemoryConsolidate.ts: promotion/archival heuristics
- SemanticSearch.ts: cross-agent search via MemoryGrant
- Jack Dorsey's "Company World Model" — Flair as organizational nervous system
