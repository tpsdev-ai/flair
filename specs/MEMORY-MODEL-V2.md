# Flair Memory Model v2

## Status
- **Owner:** Flint
- **Priority:** P1 — foundational to 1.0
- **Context:** Design session with Nathan, 2026-04-06; trust-tier revision 2026-04-08 (drop passive/time-based trust)

## Summary

Flair's current memory model is private-by-default with explicit grants for cross-agent access. This spec redesigns it around open-by-default reads, subject-based relevance, trust-gated bootstrap, and simplified auth for any client.

---

## 1. Open Reads, Authenticated Writes

### Current Model
- Memories are private to the writing agent
- Cross-agent reads require explicit MemoryGrant
- MemoryGrant table is empty in practice — no one uses it
- Result: agents learn the same lessons independently, zero knowledge compounding

### New Model
- **All memories readable by all agents.** No grants needed for reads.
- **Writes are authenticated.** Ed25519 identity guarantees provenance — you know WHO wrote it.
- **Private memories are opt-in.** `visibility: "private"` for genuinely sensitive content. Everything else is accessible.

### Rationale
Agents in a Flair instance are part of the same organization. The current isolation model was built for untrusted multi-tenant scenarios that don't match our use case. Knowledge should compound across the org without coordination overhead.

### What this changes
- SemanticSearch: remove the agent-scoping filter by default. Only scope to own agent when `visibility: "private"` is set.
- BootstrapMemories: add cross-agent sources (see Section 3).
- MemoryGrant: no longer needed for reads. May be repurposed or deprecated.

---

## 2. Subjects, Not Scopes

### Problem
Knowledge doesn't have one owner or one audience. A memory about "Harper v5 sandbox" is personal (I hit the bug), project-relevant (flair team), and organizationally useful (anyone deploying Harper). Forcing it into one visibility bucket loses signal.

### Solution: Subject Tagging
Use the existing `subject` field on Memory for topic tagging:

```
subject: "flair"          → about the flair project
subject: "deployment"     → about deployment practices
subject: "harper"         → about Harper internals
subject: "security"       → about security patterns
```

Agents declare their subjects of interest in their soul:

```bash
flair soul set --agent sherlock --key subjects --value "security,flair,deployment"
```

### How subjects surface in bootstrap
Bootstrap assembles context from three sources:

```
1. Your own memories (recency-weighted, all subjects)
2. Subject-matched memories from other agents (their subjects overlap with yours)
3. Tribal knowledge (office-visible, from distillation)
```

No grants, no ACLs. Just "what topics does this agent care about?"

### Serendipity for future agents
Any new agent that joins and declares `subjects: ["deployment"]` immediately gets the benefit of everything every agent ever learned about deployment. No retroactive grants. Knowledge compounds without coordination.

---

## 3. Trust Model — Gating Cross-Agent Influence

### Problem: Memory Poisoning
Open reads mean a compromised or hallucinating agent can write plausible-looking bad advice that surfaces in every agent's bootstrap. Content safety scanning catches obvious injection, but subtle misinformation is harder.

### Principle
The data is open but the **influence** is gated. A poisoned memory exists in the database and is discoverable via search, but doesn't silently inject into other agents' bootstrap context.

### Trust Tiers

| Tier | Source | Bootstrap? | Examples |
|------|--------|------------|----------|
| 1. **Endorsed** | Human promoted to permanent, or explicit approval | Yes, highest priority | `durability: permanent`, HITL-approved distillation |
| 2. **Corroborated** | N+ agents (N ≥ 2) independently arrived at same conclusion via DistillTribalKnowledge consensus | Yes | `source: "tribal-distill"`, consensus score ≥ threshold |
| 3. **Unverified** | Single source, no corroboration, no endorsement | Search only | Fresh memories, new agents, unvalidated claims |

Cross-agent bootstrap only pulls from tiers 1-2. Tier 3 stays discoverable via explicit search but never auto-injects into other agents' context.

**Note (revised 2026-04-08):** An earlier draft included a fourth tier, `Battle-tested`, sourced from time-based signals (age, retrieval count, "never been superseded"). This tier has been removed. See next section.

### Trust does not grow passively

**Time is not a trust signal.** Age means survival, not truth. A memory that has existed for 90 days without being superseded is *durable*, not *correct*. Stale wrong information is worse than fresh wrong information because it has acquired the appearance of being established.

**The long-game attack.** Passive-trust systems are specifically vulnerable to adversaries who play a long game: an attacker plants plausible-looking memories, lets them accrue age and retrieval count, builds a "good track record" by avoiding anything obviously bad, and then weaponizes the earned trust at the moment it matters. Account age, memory age, never-superseded flags, retrieval counts — all of these are farmable by a patient adversary and cannot be used as trust inputs.

**Rule:** Trust is earned exclusively through an **active signal**:
- A human explicitly endorses the memory (human in the loop), OR
- N+ independent sources converge on the same conclusion (consensus via distillation)

An entity with no endorsement and no corroboration remains at `unverified` indefinitely, regardless of how long it has existed or how many times it has been retrieved. Trust never graduates on its own.

### What actually signals trust
1. **Provenance** — who wrote it, and whether that identity has been explicitly endorsed
2. **Corroboration** — did N+ independent sources converge on the same conclusion (consensus via distillation)
3. **Explicit human endorsement** — promoted to permanent, approved during HITL review

**Not** signals of trust, even though they might feel like it:
- Memory age
- Memory retrieval count
- "Never been superseded"
- Agent account age
- Any metric that an attacker could accrue by waiting or by farming low-cost activity

---

## 4. Memory Correction and Improvement

### Self-correction (already works)
Agent writes new memory with `supersedes: <old-id>`. SemanticSearch filters out superseded records. Clean version chain.

### Cross-agent correction
Agent A's memory becomes outdated after Agent B changes something. Currently no mechanism for B to correct A's memory.

**Solution:** Outranking, not editing.
- B writes a memory about the same topic with current information
- DistillTribalKnowledge surfaces the contradiction
- Synthesis agent resolves it, writes tribal knowledge with the current truth
- Distilled memory outranks the stale individual memory in bootstrap
- Original memories preserved as history ("we used to think X")

### Refinement over time
Memories evolve: rough observation → specific finding → distilled principle. Each step is a `supersedes` chain.

### Proposed improvements
- **Dedup-as-supersede:** When dedup detects >0.95 similarity, instead of rejecting, offer to supersede if the new version has more detail
- **`flair memory correct <id>`:** CLI shorthand that creates a superseding memory with inherited tags/subject/durability
- **Staleness signal:** Flag memories whose referenced files/resources have significantly changed (future — needs codebase awareness)

---

## 5. Agent Tokens — Simple Auth for Any Client

### Problem
Ed25519 signing requires a key file and a signing library. Mobile clients, web apps, and simple scripts can't do this easily. The current auth model is powerful but has high friction for onboarding.

### Solution: Bearer Tokens

```bash
flair agent add mybot
# Output:
#   Agent: mybot
#   Token: flair_abc123xyz...
```

One string. Works everywhere — mobile, web, CLI, MCP, curl.

### How it works
- `flair agent add` generates the Ed25519 keypair server-side and issues a token
- Token is per-agent, maps to the agent's identity in Harper
- Client sends `Authorization: Bearer flair_abc123...`
- Server looks up token, resolves to agent ID, same auth pipeline

### Security
- Per-agent, revocable (`flair agent rotate-key` invalidates the token)
- TLS required for remote (protects token in transit)
- Rate limiting already exists per-agent
- Ed25519 signing still supported as the stronger auth path for clients that can do it

### Auth hierarchy
```
Ed25519 signed request  → strongest, for flair-client / local agents
Bearer token            → simple, for mobile / web / scripts
Admin basic auth        → admin operations only
```

---

## 6. Remote MCP Server

### Problem
Local MCP servers (stdio) only work when the client can launch a subprocess. Mobile Claude, web agents, cloud-hosted agents can't do this. They need a remote MCP server.

### Architecture

```
Any MCP client → (HTTP+SSE, bearer token) → flair-mcp (remote) → Harper
```

flair-mcp becomes a deployable server, not just an npx-launched subprocess.

### Open questions (for further design)
- **Baked into Harper or separate process?** One process is simpler for "runs on a Mac Mini." Separate is more flexible for scaling.
- **Claude iOS MCP config:** How does the Claude iOS app configure remote MCP servers? Need to research actual UX before designing the flow.
- **MCP auth standard:** The MCP spec is evolving on auth (OAuth 2.1 direction). Our bearer token approach should be compatible with whatever the spec settles on.

---

## 7. Interfaces Summary

| Interface | Transport | Auth | Use case |
|-----------|-----------|------|----------|
| flair-client (JS/TS) | HTTP | Ed25519 or bearer token | Local and remote agents |
| flair-mcp (local) | stdio | None (subprocess trust) | Claude Code, Cursor |
| flair-mcp (remote) | HTTP+SSE | Bearer token | Mobile, web, cloud agents |
| CLI | HTTP | Ed25519 or admin basic | Human operators |
| Harper REST | HTTP | Ed25519 or admin basic | Direct API access |
| Unix socket | IPC | Process-level | Local high-performance path |
| Python client | HTTP | Bearer token | LangChain, CrewAI, scripts |

### Priority for 1.0
1. Bearer token auth (enables all simple clients)
2. Remote flair-mcp server mode
3. Subject-aware bootstrap
4. Trust-gated cross-agent bootstrap
5. Python client (thin wrapper)

---

## Migration Path

### From current model to v2
1. Add bearer token auth alongside Ed25519 (non-breaking)
2. Add `subjects` soul entry support to BootstrapMemories
3. Change SemanticSearch default from agent-scoped to open (breaking — but MemoryGrant is unused, so low impact)
4. Add trust scoring to BootstrapMemories for cross-agent sources
5. Deprecate MemoryGrant for reads (keep for audit/future multi-org)

### Backward compatibility
- Existing agents with Ed25519 keys continue to work unchanged
- `visibility: "private"` preserves per-agent isolation for specific memories
- MemoryGrant can remain for explicit access control if needed later

---

## References
- Design session: Nathan + Flint, 2026-04-06
- DistillTribalKnowledge spec: `specs/DISTILL-TRIBAL-KNOWLEDGE.md`
- Jack Dorsey "Company World Model" essay — organizational knowledge layer
- MCP spec auth discussion — remote protected servers consensus
- ops-125: CIMD-compatible agent metadata endpoint
