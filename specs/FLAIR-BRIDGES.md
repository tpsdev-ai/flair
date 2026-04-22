# FLAIR-BRIDGES: Pluggable Memory Bridge System

> A pluggable contract for importing/exporting memories between Flair and foreign memory systems. Agent-authorable, declarative-first.

**Status:** Draft
**Priority:** P0 — Flair 1.0
**Owner:** Flint
**Target:** Agents (not humans) can write a working bridge in one shot from the contract alone.

---

## § 1 Problem

Foreign agent-memory formats are proliferating (agentic-stack `.agent/`, Mem0, Letta, Zep, LangGraph checkpoints, Anthropic memory stores, the next viral one). Flair is the persistent cross-agent semantic layer — but only if it speaks their formats.

Point bridges don't scale. Every new target is a new PR, a new code path, a new test suite. The ecosystem is growing weekly; a four-person team cannot maintain the fan-out.

**Solution:** one `MemoryBridge` plugin contract. Two reference adapters in-tree. Convention-based discovery. The long tail gets written by agents (and by us, and by contributors) against a stable schema.

## § 2 Design Principles — Agent-Authorable First

The primary author of a bridge is an agent reading this spec. Every design decision optimizes for that:

1. **Schema upfront.** No discovery required — every field Flair stores is listed in § 4.
2. **Two shapes only.** YAML field-mapping for file-format targets (~80% of cases). Code plugin for API targets.
3. **Scaffold & test in-tree.** `flair bridge scaffold <name>` emits a working starter; `flair bridge test <name>` runs a round-trip diff.
4. **Convention discovery.** `flair-bridge-*` packages auto-register. No manifest file.
5. **LLM-readable errors.** Field paths + expected/got. Never a stack trace.
6. **One-page contract.** This spec. Paste it into any capable agent, get a correct bridge back.

## § 3 Command Surface

```
flair bridge list                           # installed bridges
flair bridge scaffold <name> [--api|--file] # emit starter files
flair bridge test <name> [--fixture <path>] # round-trip diff
flair bridge import <name> <src> [opts]     # bring memories INTO Flair
flair bridge export <name> <dst> [opts]     # send memories OUT of Flair
```

Common import/export options:

```
--agent <id>         Scope to one agent (default: all agents visible to caller)
--subject <subj>     Filter by subject tag
--since <iso>        validFrom >= this timestamp
--durability <tier>  Only ephemeral | standard | persistent | permanent
--dry-run            Parse + validate, no writes
--allow-remote       Required if the bridge hits a remote API (see § 7)
```

## § 4 Memory Record Schema (the contract)

A bridge imports/exports **records**. Each record maps to Flair's `Memory` table:

```ts
interface BridgeMemory {
  // Identity
  id?: string              // Flair ID if round-tripping; omit on first import
  foreignId?: string       // original ID in the foreign system (preserved)

  // Content
  content: string          // REQUIRED
  subject?: string         // entity this memory is about
  tags?: string[]
  visibility?: "private" | "shared" | "public"

  // Durability & lifecycle
  durability?: "ephemeral" | "standard" | "persistent" | "permanent"
  createdAt?: string       // ISO-8601; defaults to now on import
  validFrom?: string
  validTo?: string         // null means still valid
  expiresAt?: string

  // Ownership
  agentId?: string         // required on import unless --agent is passed

  // Provenance
  source?: string          // human-readable source label
  derivedFrom?: string[]   // foreign IDs this was derived from
}
```

**Required on import:** `content` and (`agentId` OR `--agent` flag).
**Everything else is optional.** Bridges SHOULD preserve `foreignId` so re-import is idempotent.

Flair-owned fields a bridge MUST NOT set: `contentHash`, `embedding`, `retrievalCount`, `lastRetrieved`, `promotionStatus`, `_safetyFlags`, any `*By` audit field. These are computed on ingest.

## § 5 Plugin Shape A — Declarative YAML (file-format bridges)

For bridges whose source/target is a directory of files, write a YAML descriptor. No code.

```yaml
# .flair-bridge/agentic-stack.yaml
name: agentic-stack
version: 1
kind: file
detect:
  anyExists: [".agent/AGENTS.md", ".agent/memory/semantic/lessons.jsonl"]

import:
  sources:
    - path: ".agent/memory/semantic/lessons.jsonl"
      format: jsonl
      map:
        content: "$.claim"
        subject: "$.topic"
        tags: "$.tags"
        foreignId: "$.id"
        durability: "persistent"
        source: "agentic-stack/lessons"

export:
  targets:
    - path: ".agent/memory/semantic/lessons.jsonl"
      format: jsonl
      when: "durability in ['persistent', 'permanent']"
      map:
        id: "foreignId ?? id"
        claim: "content"
        topic: "subject"
        tags: "tags"
```

**Path expressions:** JSONPath subset — `$.field`, `$.nested.field`, `$.array[*]`.
**`when:`** a boolean expression over BridgeMemory fields. Omitted = always.
**Formats supported in 1.0:** `jsonl`, `json`, `yaml`, `markdown-frontmatter`.
**What the runtime gives you:** file discovery, format parsing, schema validation, error reporting with line:column. You only describe the mapping.

## § 6 Plugin Shape B — Code Plugin (API bridges)

For bridges that talk to remote APIs (Mem0, Letta, Zep, Anthropic memory):

```ts
// flair-bridge-mem0/index.ts
import type { MemoryBridge, BridgeMemory, BridgeContext } from "@tpsdev-ai/flair";

export const bridge: MemoryBridge = {
  name: "mem0",
  version: 1,
  kind: "api",

  options: {
    apiKey:  { env: "MEM0_API_KEY", required: true },
    userId:  { required: true },
    baseUrl: { default: "https://api.mem0.ai" },
  },

  async *import(opts, ctx: BridgeContext): AsyncIterable<BridgeMemory> {
    const res = await ctx.fetch(`${opts.baseUrl}/v1/memories/?user_id=${opts.userId}`, {
      headers: { Authorization: `Token ${opts.apiKey}` },
    });
    for (const m of (await res.json()).results) {
      yield {
        foreignId: m.id,
        content: m.memory,
        createdAt: m.created_at,
        tags: m.categories,
        source: "mem0",
      };
    }
  },

  async export(memories, opts, ctx): Promise<void> {
    for await (const m of memories) {
      await ctx.fetch(`${opts.baseUrl}/v1/memories/`, {
        method: "POST",
        headers: { Authorization: `Token ${opts.apiKey}` },
        body: JSON.stringify({ messages: [{ role: "user", content: m.content }], user_id: opts.userId }),
      });
    }
  },
};
```

**`BridgeContext`** provides: `ctx.fetch` (instrumented, rate-limited), `ctx.log` (structured), `ctx.cache` (per-bridge KV).
**No direct filesystem or network access** — always through `ctx`. Enables sandboxing + auditability.

## § 7 Discovery, Distribution, Trust

### Discovery

On `flair bridge list`, the runtime scans:

1. `.flair-bridge/*.yaml` in the current project (declarative, Shape A)
2. `~/.flair/bridges/*.yaml` (user-scoped declarative)
3. Node modules matching `flair-bridge-*` or `@*/flair-bridge-*` (code plugins, Shape B)
4. Built-ins shipped in `@tpsdev-ai/flair`

### Distribution

Agents publish bridges as npm packages named `flair-bridge-<target>`. No registry to curate for 1.0 — npm is the registry. `flair bridge list` shows everything installed.

### Trust model (1.0 cut)

| Source                       | Default                    |
|------------------------------|----------------------------|
| Built-in (agentic-stack, mem0) | Allowed                  |
| Declarative YAML (no code)   | Allowed (no remote without `--allow-remote`) |
| Code plugin from npm         | Requires `flair bridge allow <name>` on first use |
| Remote API calls             | Always require `--allow-remote` flag on the invocation |

A code plugin is untrusted JS. Future (1.1): VM isolation + capability-scoped `ctx`. For 1.0: explicit opt-in plus `ctx` being the only network door keeps the surface area small and auditable.

## § 8 Round-Trip Testing

Every bridge ships a fixture. `flair bridge test <name>` runs:

1. Import fixture → `BridgeMemory[]`
2. Export those memories to a tmp target
3. Re-import from tmp → `BridgeMemory[]'`
4. Structural diff on `(content, subject, tags, durability)` — round-trip stable fields
5. Pass iff diff is empty

Agents iterate against this signal. Pass = ship.

## § 9 Reference Adapters (shipped in 1.0)

### 9.1 `agentic-stack` (Shape A — file)

Imports `.agent/memory/semantic/lessons.jsonl` → persistent memories tagged `source: "agentic-stack/lessons"`.
Exports persistent memories → `lessons.jsonl` using agentic-stack's `{id, claim, topic, tags}` schema.
Detects by presence of `.agent/AGENTS.md`.

### 9.2 `mem0` (Shape B — API)

Imports all memories for a `user_id` → Flair memories scoped to `--agent`, source `mem0`.
Exports Flair memories → Mem0 as user memories with categories from tags.
Requires `MEM0_API_KEY` env + `--user-id`.

These two prove both shapes. Long tail (Letta, Zep, LangGraph, Anthropic memory) is ecosystem-authored post-1.0.

## § 10 Error Format

Every bridge error is structured:

```json
{
  "bridge": "agentic-stack",
  "op": "import",
  "path": ".agent/memory/semantic/lessons.jsonl",
  "record": 42,
  "field": "$.claim",
  "expected": "string",
  "got": "null",
  "hint": "lessons.jsonl row 42 has no 'claim' field — skipped"
}
```

Printed as a single JSON object per line when `--json`; human-formatted otherwise. Field paths, expected/got, and a hint — that's the minimum an LLM needs to self-correct.

## § 11 Out of Scope for 1.0

- **Streaming sync / watch mode.** 1.0 is batch import/export only. Continuous sync is 1.1+.
- **Conflict resolution UI.** 1.0 re-import is idempotent on `foreignId` (upsert). No merge prompts.
- **Per-bridge marketplace.** npm is the marketplace. No discovery portal in 1.0.
- **VM-isolated code plugins.** 1.0 uses trust prompt + `ctx`-only network. Isolation is a 1.1 hardening pass.
- **Cross-agent trust tier propagation across bridges.** Imports land at `unverified` by default; operator can pass `--trust <tier>` if they know the source.

## § 12 Open Questions

1. **Declarative expression language:** JSONPath subset for reads is fine. For `when:` conditions — do we hand-roll (simple, agent-writable) or use something like JMESPath (standardized, heavier)? Leaning hand-roll.
2. **Upsert key for re-import:** `foreignId` is obvious for external-origin memories. What about round-tripping a Flair memory through a foreign system and back? Leaning: preserve Flair `id` in an extended field (`x-flair-id`) when the target format supports free-form metadata; fall back to content hash otherwise.
3. **Bulk API rate limiting:** Mem0, Letta etc. all have rate limits. Does `ctx.fetch` handle backoff or does the plugin? Leaning: `ctx.fetch` applies a configurable token bucket, plugin declares `rateLimit: { rps: 10 }` in options.

---

## Appendix: Agent Prompt Example

> You are implementing a Flair bridge for [FOREIGN_SYSTEM]. Read § 4, § 5 or § 6 (depending on whether FOREIGN_SYSTEM exposes files or an API), and § 8. Produce either a `.flair-bridge/<name>.yaml` file (file-format target) or an `index.ts` implementing `MemoryBridge` (API target). Include a fixture at `fixtures/<name>.fixture.json` (for file targets) or mock responses in `fixtures/<name>.mock.json` (for API targets). Run `flair bridge test <name>` and iterate until the round-trip diff is empty.

If the appendix above is enough for an agent to ship a working bridge, this spec has done its job.
