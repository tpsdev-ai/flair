# System Requirements

Flair runs Harper v5 (a Node.js HTTP+storage runtime) plus a small CLI/MCP layer. This page documents what to expect at idle, with measured numbers from in-production deployments.

## Minimum

| Resource | Spec | Notes |
|---|---|---|
| RAM | 1 GB free | 500–800 MB resident is typical for a single-agent spoke. |
| Disk | 250 MB | Harper data dir grows ~50–200 MB per active agent over weeks. |
| Node | 22 LTS or 24 LTS | Native fetch + WebStreams. Verified on 22.22.x and 25.9.x. |
| Network | Outbound HTTPS | For federation-sync to a hub. Local-only deployments need none. |

## Measured at idle (single agent, no load)

| Host | RAM (RSS) | Data dir | Node | Uptime | Notes |
|---|---|---|---|---|---|
| rockit (Mac mini, 16 GB) | 740 MB daemon + ~175 MB across 4 flair-mcp clients = ~915 MB total | 163 MB | 25.9.0 | 35 min | Hub for rockit↔Fabric pair; local agent count: 4 (flint, kern, sherlock, ember). |
| pulse (Linux VM, 19 GB pool) | 500 MB | 88 MB | 22.22.0 | 3d 20h | Spoke; 1 agent (pulse). |
| tps-anvil (Linux VM, 19 GB pool) | (not running) | 71 MB | 22.22.1 | — | Linux deps issue, P1 backlog. |

## What drives the numbers

- **Embedding cache.** First semantic search per cold daemon loads `Xenova/all-MiniLM-L6-v2` into memory (~85 MB). Subsequent searches reuse it. If you disable embeddings (text-only search), strip ~100 MB.
- **HNSW index.** In-memory vector index over the agent's memories. Grows linearly with memory count; expect ~1 KB per memory plus the 384-dim vector (~1.5 KB).
- **Harper transaction log.** Bounded by retention window; grows during writes, compacts on idle.
- **MCP clients.** Each `flair-mcp` subprocess holds ~40–50 MB. Long-lived MCP host (Claude Code) restarts spawn fresh ones; orphaned ones from the host crashing should be cleaned up by the parent-exit watcher (PR pending).

## Scaling expectations

The numbers above are 1-agent steady state. Per additional agent on the same daemon:

- ~50 MB additional RSS (per-agent HNSW index + small per-agent caches).
- ~10–30 MB additional data-dir growth per week of active use.

A 4-agent rockit at full embeddings + federation runs comfortably in 1 GB. An 8-agent host is fine in 2 GB. Multi-org hubs with hundreds of agents would want measured sizing — file an issue or join the Discord.

## Known constraints

- **Free Fabric tier.** ~512 MB plan ceiling. The full embedding model + HNSW + Harper is tight at that ceiling for a multi-agent spoke; a 1-agent personal spoke fits. Larger deployments (Phase 2 SLM-summarization, multi-agent hubs) require a paid Fabric tier or self-host.
- **Cold-start.** Embedding model load is ~3–5 s on Mac arm64, ~8–12 s on commodity Linux x86. Subsequent operations are warm.
- **No GPU required.** Embeddings run on CPU. HNSW is in-memory and CPU-only. GPU only matters if you deploy a Phase 2 SLM-based summarizer (separate process — see [bridges.md](./bridges.md#phase-2-summary-service)).
