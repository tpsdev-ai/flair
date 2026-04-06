/**
 * POST /DistillTribalKnowledge
 *
 * Cross-agent knowledge synthesis. Clusters similar memories across agents
 * using existing HNSW embeddings, identifies consensus and contradictions,
 * and returns a structured synthesis prompt for agent-side LLM processing.
 *
 * Flair is the data layer — it does clustering and returns raw material.
 * The calling agent feeds the synthesis prompt to its own LLM and writes
 * distilled tribal knowledge back as office-visible memories.
 *
 * Request:
 *   agents         string[]  — agents to cross-reference (required)
 *   minAgents      number    — minimum agents per cluster for consensus (default: 2)
 *   minSimilarity  number    — cosine similarity threshold (default: 0.7)
 *   maxClusters    number    — cap on output clusters (default: 20)
 *   scope          string    — "all" | "recent" | "persistent-only" (default: "all")
 *   since          string?   — ISO timestamp lower bound (with scope=recent)
 *   focus          string?   — query to bias clustering toward a topic
 *
 * Response:
 *   clusters        Cluster[]
 *   contradictions  Contradiction[]
 *   prompt          string    — synthesis prompt for the agent's LLM
 *   stats           object
 */

import { Resource, databases } from "@harperfast/harper";
import { getEmbedding } from "./embeddings-provider.js";
import { isAdmin } from "./auth-middleware.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemoryRecord {
  id: string;
  agentId: string;
  content: string;
  embedding?: number[];
  durability?: string;
  type?: string;
  tags?: string[];
  createdAt?: string;
  archived?: boolean;
  visibility?: string;
}

interface ClusterMember {
  id: string;
  agentId: string;
  content: string;
  similarity: number;
  durability?: string;
  type?: string;
}

interface Cluster {
  id: string;
  theme: string;
  consensusScore: number;
  agentCount: number;
  agents: string[];
  memories: ClusterMember[];
}

interface Contradiction {
  memoryA: { id: string; agentId: string; content: string };
  memoryB: { id: string; agentId: string; content: string };
  similarity: number;
  type: string;
}

// ─── Vector math ──────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const sum = new Float64Array(dims);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) sum[i] += v[i];
  }
  const result = new Array(dims);
  for (let i = 0; i < dims; i++) result[i] = sum[i] / vectors.length;
  return result;
}

// ─── Theme extraction ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
  "that", "this", "it", "its", "and", "or", "but", "not", "no", "if",
  "then", "than", "so", "up", "out", "just", "also", "very", "all",
  "any", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "too", "when", "where", "how", "what",
  "which", "who", "whom", "why", "there", "here", "now", "new", "use",
  "used", "using", "one", "two", "set", "get",
]);

function extractTheme(memories: { content: string }[]): string {
  const freq = new Map<string, number>();
  for (const m of memories) {
    const words = m.content.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/);
    const seen = new Set<string>();
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  // Keep terms that appear in at least 2 memories (cross-agent signal)
  const terms = [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
  return terms.join(", ") || "unlabeled cluster";
}

// ─── Contradiction detection ──────────────────────────────────────────────────

const NEGATION_PAIRS = [
  [/\bdon['']?t\b/i, /\balways\b/i],
  [/\bavoid\b/i, /\bprefer\b/i],
  [/\bnever\b/i, /\balways\b/i],
  [/\bshould\s+not\b/i, /\bshould\b/i],
  [/\bdon['']?t\b/i, /\bdo\b/i],
];

function detectContradictionType(a: string, b: string): string | null {
  for (const [negPat, posPat] of NEGATION_PAIRS) {
    if ((negPat.test(a) && posPat.test(b)) || (negPat.test(b) && posPat.test(a))) {
      return "opposing_conclusions";
    }
  }
  return null;
}

// ─── Main resource ────────────────────────────────────────────────────────────

export class DistillTribalKnowledge extends Resource {
  async post(data: any) {
    const {
      agents,
      minAgents = 2,
      minSimilarity = 0.7,
      maxClusters = 20,
      scope = "all",
      since,
      focus,
    } = data || {};

    if (!agents || !Array.isArray(agents) || agents.length < 2) {
      return new Response(
        JSON.stringify({ error: "agents must be an array of at least 2 agent IDs" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    const actorId: string | undefined = (this as any).request?.tpsAgent;
    const callerIsAdmin: boolean = (this as any).request?.tpsAgentIsAdmin === true;

    if (!callerIsAdmin && actorId) {
      // Non-admin: verify grants for each requested agent
      const grantedAgents = new Set<string>();
      grantedAgents.add(actorId); // always allowed own memories
      try {
        for await (const grant of (databases as any).flair.MemoryGrant.search({
          conditions: [{ attribute: "granteeId", comparator: "equals", value: actorId }],
        })) {
          if (grant.scope === "search" || grant.scope === "read") {
            grantedAgents.add(grant.ownerId);
          }
        }
      } catch { /* MemoryGrant may not exist */ }

      const unauthorized = agents.filter((a: string) => !grantedAgents.has(a));
      if (unauthorized.length > 0) {
        return new Response(
          JSON.stringify({ error: `forbidden: no grant for agents: ${unauthorized.join(", ")}` }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // ── Collect memories ──────────────────────────────────────────────────
    const agentSet = new Set(agents as string[]);
    const sinceDate = since ? new Date(since) : null;
    const allMemories: MemoryRecord[] = [];

    for await (const record of (databases as any).flair.Memory.search()) {
      if (!agentSet.has(record.agentId)) continue;
      if (record.archived) continue;
      if (!record.content || !record.embedding || record.embedding.length === 0) continue;

      if (scope === "recent" && sinceDate) {
        if (!record.createdAt || new Date(record.createdAt) < sinceDate) continue;
      }
      if (scope === "persistent-only") {
        if (record.durability !== "persistent" && record.durability !== "permanent") continue;
      }

      allMemories.push(record);
    }

    // ── Focus bias ────────────────────────────────────────────────────────
    let focusEmbedding: number[] | null = null;
    if (focus) {
      try { focusEmbedding = await getEmbedding(String(focus).slice(0, 8000)); } catch {}
    }

    let workingSet = allMemories;
    if (focusEmbedding) {
      // Pre-filter to memories relevant to the focus topic
      workingSet = allMemories
        .map(m => ({ ...m, focusSim: cosineSimilarity(m.embedding!, focusEmbedding!) }))
        .filter(m => m.focusSim > 0.3)
        .sort((a, b) => b.focusSim - a.focusSim)
        .slice(0, 200); // cap to avoid O(n^2) explosion
    }

    // ── Build cross-agent similarity pairs ────────────────────────────────
    type SimPair = { i: number; j: number; sim: number };
    const pairs: SimPair[] = [];
    for (let i = 0; i < workingSet.length; i++) {
      for (let j = i + 1; j < workingSet.length; j++) {
        // Only cross-agent pairs
        if (workingSet[i].agentId === workingSet[j].agentId) continue;
        const sim = cosineSimilarity(workingSet[i].embedding!, workingSet[j].embedding!);
        if (sim >= minSimilarity) {
          pairs.push({ i, j, sim });
        }
      }
    }
    pairs.sort((a, b) => b.sim - a.sim);

    // ── Greedy agglomerative clustering ───────────────────────────────────
    const assigned = new Set<number>();
    const clusters: { members: number[]; embeddings: number[][] }[] = [];

    for (const pair of pairs) {
      if (clusters.length >= maxClusters * 2) break; // over-generate, filter later

      const iAssigned = assigned.has(pair.i);
      const jAssigned = assigned.has(pair.j);

      if (!iAssigned && !jAssigned) {
        // New cluster
        clusters.push({
          members: [pair.i, pair.j],
          embeddings: [workingSet[pair.i].embedding!, workingSet[pair.j].embedding!],
        });
        assigned.add(pair.i);
        assigned.add(pair.j);
      } else if (iAssigned && !jAssigned) {
        // Add j to i's cluster if similar to centroid
        const cluster = clusters.find(c => c.members.includes(pair.i))!;
        const cent = centroid(cluster.embeddings);
        if (cosineSimilarity(workingSet[pair.j].embedding!, cent) >= minSimilarity) {
          cluster.members.push(pair.j);
          cluster.embeddings.push(workingSet[pair.j].embedding!);
          assigned.add(pair.j);
        }
      } else if (!iAssigned && jAssigned) {
        const cluster = clusters.find(c => c.members.includes(pair.j))!;
        const cent = centroid(cluster.embeddings);
        if (cosineSimilarity(workingSet[pair.i].embedding!, cent) >= minSimilarity) {
          cluster.members.push(pair.i);
          cluster.embeddings.push(workingSet[pair.i].embedding!);
          assigned.add(pair.i);
        }
      }
      // Both assigned: skip (don't merge clusters)
    }

    // ── Filter for consensus & build output ───────────────────────────────
    const outputClusters: Cluster[] = [];
    for (let ci = 0; ci < clusters.length && outputClusters.length < maxClusters; ci++) {
      const cluster = clusters[ci];
      const members = cluster.members.map(idx => workingSet[idx]);
      const uniqueAgents = [...new Set(members.map(m => m.agentId))];
      if (uniqueAgents.length < minAgents) continue;

      const cent = centroid(cluster.embeddings);
      const clusterMembers: ClusterMember[] = members.map(m => ({
        id: m.id,
        agentId: m.agentId,
        content: m.content.slice(0, 500),
        similarity: Math.round(cosineSimilarity(m.embedding!, cent) * 1000) / 1000,
        durability: m.durability,
        type: m.type,
      }));

      // Durability weight: clusters with persistent/permanent memories score higher
      const durWeights: Record<string, number> = { permanent: 1, persistent: 0.8, standard: 0.5, ephemeral: 0.2 };
      const avgDurWeight = members.reduce((sum, m) => sum + (durWeights[m.durability ?? "standard"] ?? 0.5), 0) / members.length;
      const avgSim = clusterMembers.reduce((sum, m) => sum + m.similarity, 0) / clusterMembers.length;
      const consensusScore = Math.round((uniqueAgents.length / agents.length) * avgSim * avgDurWeight * 1000) / 1000;

      outputClusters.push({
        id: `cluster-${String(ci + 1).padStart(3, "0")}`,
        theme: extractTheme(members),
        consensusScore,
        agentCount: uniqueAgents.length,
        agents: uniqueAgents,
        memories: clusterMembers,
      });
    }
    outputClusters.sort((a, b) => b.consensusScore - a.consensusScore);

    // ── Contradiction detection ───────────────────────────────────────────
    const contradictions: Contradiction[] = [];
    for (const pair of pairs.slice(0, 500)) {
      const a = workingSet[pair.i];
      const b = workingSet[pair.j];
      if (pair.sim < 0.6) continue;
      const type = detectContradictionType(a.content, b.content);
      if (type) {
        contradictions.push({
          memoryA: { id: a.id, agentId: a.agentId, content: a.content.slice(0, 300) },
          memoryB: { id: b.id, agentId: b.agentId, content: b.content.slice(0, 300) },
          similarity: Math.round(pair.sim * 1000) / 1000,
          type,
        });
      }
      if (contradictions.length >= 10) break;
    }

    // ── Build synthesis prompt ─────────────────────────────────────────────
    const clusterSummaries = outputClusters.map((c, i) => {
      const memList = c.memories
        .map((m, j) => `  [${j + 1}] (${m.agentId}) ${m.content.slice(0, 200)}`)
        .join("\n");
      return `### Cluster ${i + 1}: ${c.theme} (consensus: ${c.consensusScore}, agents: ${c.agents.join(", ")})\n${memList}`;
    }).join("\n\n");

    const contradictionSummaries = contradictions.map((c, i) =>
      `### Contradiction ${i + 1} (similarity: ${c.similarity}):\nAgent ${c.memoryA.agentId}: "${c.memoryA.content.slice(0, 150)}"\nAgent ${c.memoryB.agentId}: "${c.memoryB.content.slice(0, 150)}"`
    ).join("\n\n");

    const prompt = `# Tribal Knowledge Synthesis

You are synthesizing organizational knowledge from ${agents.length} AI agents: ${agents.join(", ")}.
${focus ? `\nFocus area: ${focus}` : ""}

## Clusters (${outputClusters.length} found)
For each cluster, write ONE concise tribal knowledge statement that captures what the team collectively knows.

${clusterSummaries || "(no clusters found)"}

${contradictions.length > 0 ? `## Contradictions (${contradictions.length} found)
For each contradiction, explain the tension and suggest a resolution.

${contradictionSummaries}` : ""}

## Output Format
For each cluster, produce:
- INSIGHT: <one paragraph distilling what the team collectively knows>
- CONFIDENCE: high | medium | low
- ACTION: <optional — what should change based on this insight>
- TAGS: <comma-separated relevant tags>

${contradictions.length > 0 ? `For each contradiction:
- TENSION: <what's conflicting>
- RESOLUTION: <suggested resolution or "needs human decision">` : ""}

## Writing Back
For each insight you want to persist, write it as a Flair memory with:
- durability: persistent
- type: fact or lesson
- source: tribal-distill
- derivedFrom: [list the source memory IDs from the cluster]
- visibility: office
- tags: ["tribal-knowledge", ...]`;

    return {
      clusters: outputClusters,
      contradictions,
      prompt,
      stats: {
        totalMemories: allMemories.length,
        memoriesAnalyzed: workingSet.length,
        clustersFound: outputClusters.length,
        contradictionsFound: contradictions.length,
        agentsIncluded: agents.length,
      },
    };
  }
}
