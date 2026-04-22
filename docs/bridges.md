# Memory Bridges

> Pluggable import/export between Flair and foreign memory systems.

Flair stores memories in its own schema. The rest of the agent ecosystem stores memories too — agentic-stack's `.agent/` directory, Mem0, Letta, Zep, Anthropic memory, and more every week. **Bridges** let Flair speak those formats without a core-code change per integration.

The design goal is *agent-authorable first*: a capable agent should be able to ship a working bridge by reading this doc and running one command.

## Two shapes

| Shape | When to use | Artifact |
|-------|-------------|----------|
| **File** (YAML descriptor) | Foreign system stores memories as files on disk (`.agent/`, JSONL, Markdown) | `.flair-bridge/<name>.yaml` in a project, or `~/.flair/bridges/<name>.yaml` user-wide |
| **API** (TypeScript plugin) | Foreign system exposes an HTTP API (Mem0, Letta, Zep, Anthropic memory) | npm package named `flair-bridge-<name>` |

Pick one. The runtime normalizes both into the same memory-record shape before import.

## The memory record

Every bridge deals in `BridgeMemory` objects. Fields:

```ts
interface BridgeMemory {
  // Identity
  id?: string              // Flair ID if round-tripping; omit on first import
  foreignId?: string       // original ID in the foreign system (preserved)

  // Content
  content: string          // REQUIRED
  subject?: string
  tags?: string[]
  visibility?: "private" | "shared" | "public"

  // Durability & lifecycle
  durability?: "ephemeral" | "standard" | "persistent" | "permanent"
  createdAt?: string       // ISO-8601; defaults to now on import
  validFrom?: string
  validTo?: string
  expiresAt?: string

  // Ownership
  agentId?: string         // required on import unless --agent is passed

  // Provenance
  source?: string
  derivedFrom?: string[]
}
```

**Required on import:** `content` and (`agentId` or the `--agent` flag).

**Flair-owned, never set by a bridge:** `contentHash`, `embedding`, `embeddingModel`, `retrievalCount`, `lastRetrieved`, `promotionStatus`, `_safetyFlags`, any `*By` audit field. These are computed on ingest; if a bridge emits them they're ignored.

## Commands

```bash
flair bridge list                           # installed bridges
flair bridge scaffold <name> [--file|--api] # emit starter files
flair bridge test <name> [--fixture <path>] # round-trip diff (coming soon)
flair bridge import <name> <src> [opts]     # foreign → Flair (coming soon)
flair bridge export <name> <dst> [opts]     # Flair → foreign (coming soon)
```

Slice 1 of FLAIR-BRIDGES ships `list` and `scaffold`; the runtime commands (`test`, `import`, `export`) land in the next slice. Scaffold lets you author a working bridge *today* and confirm discovery; execution comes in the next release.

Common runtime options (for the slice-2 commands):

| Flag | Meaning |
|------|---------|
| `--agent <id>` | Scope to one agent (default: all agents visible to caller) |
| `--subject <subj>` | Filter by subject tag |
| `--since <iso>` | `validFrom >= this timestamp` |
| `--durability <tier>` | Only `ephemeral` / `standard` / `persistent` / `permanent` |
| `--dry-run` | Parse + validate, no writes |
| `--allow-remote` | Required for bridges that hit a remote API |

## Shape A — Declarative YAML

For bridges whose source or target is a directory of files, write a YAML descriptor. No code required.

```yaml
# .flair-bridge/agentic-stack.yaml
name: agentic-stack
version: 1
kind: file
description: "agentic-stack .agent/memory/semantic/lessons.jsonl"

detect:
  anyExists:
    - ".agent/AGENTS.md"
    - ".agent/memory/semantic/lessons.jsonl"

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

- **Path expressions:** JSONPath subset — `$.field`, `$.nested.field`, `$.array[*]`.
- **`when:`** boolean expression over `BridgeMemory` fields. Omit for "always".
- **Formats supported in 1.0:** `jsonl`, `json`, `yaml`, `markdown-frontmatter`.
- **What the runtime gives you:** file discovery, format parsing, schema validation, error reporting with `line:column`. You only describe the mapping.

## Shape B — Code plugin

For bridges that talk to HTTP APIs:

```ts
// flair-bridge-mem0/index.ts
import type { MemoryBridge, BridgeMemory, BridgeContext } from "@tpsdev-ai/flair";

export const bridge: MemoryBridge = {
  name: "mem0",
  version: 1,
  kind: "api",

  options: {
    apiKey:  { env: "MEM0_API_KEY", required: true, description: "Mem0 API token" },
    userId:  { required: true, description: "Mem0 user ID" },
    baseUrl: { default: "https://api.mem0.ai" },
  },

  async *import(opts, ctx: BridgeContext) {
    const res = await ctx.fetch(`${opts.baseUrl}/v1/memories/?user_id=${opts.userId}`, {
      headers: { Authorization: `Token ${opts.apiKey}` },
    });
    const payload = await res.json();
    for (const m of payload.results ?? []) {
      yield {
        foreignId: String(m.id),
        content: String(m.memory),
        createdAt: m.created_at,
        tags: m.categories,
        source: "mem0",
      };
    }
  },

  async export(memories, opts, ctx) {
    for await (const m of memories) {
      await ctx.fetch(`${opts.baseUrl}/v1/memories/`, {
        method: "POST",
        headers: { Authorization: `Token ${opts.apiKey}` },
        body: JSON.stringify({
          messages: [{ role: "user", content: m.content }],
          user_id: opts.userId,
        }),
      });
    }
  },
};
```

**`BridgeContext`** gives you:

- `ctx.fetch` — instrumented, rate-limited HTTP. **Always use this instead of the global `fetch`** — it's how the runtime applies per-bridge throttling and audit logging.
- `ctx.log` — structured `{debug, info, warn, error}` logger.
- `ctx.cache` — per-bridge key/value cache with optional TTL. Useful for pagination cursors, auth refresh, etc.

Code plugins have no direct filesystem or network access outside `ctx`. This keeps the surface area small and auditable.

## Discovery

`flair bridge list` scans, in precedence order:

1. **Built-ins** shipped inside `@tpsdev-ai/flair`
2. **Project YAML** — `.flair-bridge/*.yaml` in the current working directory
3. **User YAML** — `~/.flair/bridges/*.yaml`
4. **npm packages** — anything matching `flair-bridge-*` or `@scope/flair-bridge-*` under `node_modules/`

Earlier sources win on name conflict. So a built-in adapter can't be accidentally shadowed by a same-named npm package, but a project-local YAML *can* intentionally override an npm bridge for local development.

## Distribution

Publish bridges to npm as `flair-bridge-<name>`. Example `package.json`:

```json
{
  "name": "flair-bridge-mem0",
  "version": "0.1.0",
  "description": "Flair bridge for Mem0",
  "main": "index.js",
  "flair": { "kind": "api", "version": 1 },
  "peerDependencies": { "@tpsdev-ai/flair": ">=0.6.0" }
}
```

There's no registry to curate; npm is the registry. `flair bridge list` surfaces everything installed.

## Round-trip testing

Every bridge ships a fixture. `flair bridge test <name>` will run (slice 2):

1. Import the fixture → `BridgeMemory[]`
2. Export those memories to a tmp target
3. Re-import the tmp target → `BridgeMemory[]`
4. Structural diff on the round-trip-stable fields: `content`, `subject`, `tags`, `durability`
5. Pass iff the diff is empty

Pass = ship. Iterate against this signal.

## Trust and security

Different sources have different blast radii.

| Source | Default trust |
|--------|---------------|
| Built-in | Allowed |
| Declarative YAML (no code) | Allowed; remote API calls require `--allow-remote` at invocation |
| Code plugin from npm | Requires `flair bridge allow <name>` on first use |
| Remote API calls | Always require `--allow-remote` on the invocation |

A code plugin is untrusted JavaScript. The explicit `allow` gate keeps an unreviewed npm package from executing on your machine the first time `flair bridge import` names it. VM isolation is a 1.1 hardening pass.

## Error format

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

Printed as a single JSON object per line when `--json`; human-formatted otherwise. Field paths, expected/got, and a hint — that's the minimum an LLM needs to self-correct without operator help.

## Writing your own — the prompt

If you want an agent to write a bridge for you, here's the one-shot prompt:

> You are implementing a Flair bridge for **\<FOREIGN_SYSTEM\>**. Read the sections above on the memory record, on Shape A (file-format targets) or Shape B (API targets) depending on \<FOREIGN_SYSTEM\>, and on round-trip testing. Produce either `.flair-bridge/<name>.yaml` (file targets) or an `index.ts` implementing `MemoryBridge` (API targets). Include a fixture at `fixtures/<name>.fixture.json` or `fixtures/<name>.mock.json`. Run `flair bridge test <name>` and iterate until the round-trip diff is empty.

That's the bar. If an agent can't ship a working bridge from this doc plus the scaffold, the doc is the bug.

## Full spec

The authoritative contract is in [`specs/FLAIR-BRIDGES.md`](../specs/FLAIR-BRIDGES.md). This doc is the user-facing view; the spec covers edge cases, future extensions, and design rationale.
