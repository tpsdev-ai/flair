/**
 * Import runner — bridges the `BridgeMemory` stream from the runtime
 * executor into Flair's HTTP API. Used by `flair bridge import`.
 *
 * Responsibilities:
 *  - Apply the per-invocation `--agent` default (every imported memory
 *    needs an `agentId`; the spec says either the bridge sets one or the
 *    operator passes `--agent`)
 *  - PUT each memory to `/Memory/<id>` via the caller-provided poster
 *  - Track per-source counts, success, skips, and the first error
 *  - In `--dry-run` mode, run the executor + validation but skip the PUT
 *
 * The Flair POST itself is injected as a function so this module stays
 * unit-testable without spinning up a real Flair instance.
 */

import { randomUUID } from "node:crypto";
import type { BridgeMemory, YamlBridgeDescriptor } from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { importFromYaml } from "./execute.js";
import type { BridgeContext } from "../types.js";

export interface ImportRunOptions {
  /**
   * Bridge name for error/progress reporting. Pass explicitly so the
   * runner doesn't have to reach into a descriptor it may not have (code
   * plugin path doesn't use a YAML descriptor).
   */
  bridgeName: string;
  /**
   * Source of BridgeMemory records. Exactly one must be provided:
   *   - `descriptor`: YAML descriptor — the runner builds the iterable
   *     via `importFromYaml(descriptor, { cwd, ctx })`
   *   - `source`: ready-made AsyncIterable — typical for code plugins
   *     that return their own async generator
   */
  descriptor?: YamlBridgeDescriptor;
  source?: AsyncIterable<BridgeMemory>;
  /** Filesystem root the descriptor's relative paths resolve against. */
  cwd: string;
  /** Default agent ID to apply when a memory doesn't carry one. */
  agentId?: string;
  /** When true, validate + count but don't POST. */
  dryRun?: boolean;
  /** Injected memory writer; receives the resolved memory body. */
  putMemory: (body: PutMemoryBody) => Promise<void>;
  /** Injected progress reporter — defaults to a no-op. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional ctx passed to the runtime; only used for log routing. */
  ctx?: BridgeContext;
}

export interface PutMemoryBody {
  id: string;
  agentId: string;
  content: string;
  durability: "ephemeral" | "standard" | "persistent" | "permanent";
  type: "memory";
  createdAt: string;
  subject?: string;
  tags?: string[];
  visibility?: "private" | "shared" | "public";
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
  source?: string;
  derivedFrom?: string[];
  /** Round-tripping field; we preserve the foreign id for idempotency on re-import. */
  foreignId?: string;
}

export type ProgressEvent =
  | { type: "memory-imported"; foreignId?: string; flairId: string; ordinal: number }
  | { type: "memory-skipped"; ordinal: number; reason: string }
  | { type: "done"; total: number; imported: number; skipped: number };

export interface ImportRunResult {
  total: number;
  imported: number;
  skipped: number;
}

const VALID_DURABILITY = new Set(["ephemeral", "standard", "persistent", "permanent"]);

/**
 * Drive a YAML descriptor's `import` block all the way through to PUTs
 * against `putMemory`. Errors propagate as `BridgeRuntimeError`.
 */
export async function runImport(opts: ImportRunOptions): Promise<ImportRunResult> {
  const onProgress = opts.onProgress ?? (() => {});
  let total = 0;
  let imported = 0;
  let skipped = 0;

  const iterable: AsyncIterable<BridgeMemory> = opts.source
    ?? (opts.descriptor
      ? importFromYaml(opts.descriptor, { cwd: opts.cwd, ctx: opts.ctx })
      : (() => { throw new BridgeRuntimeError({ bridge: opts.bridgeName, op: "import", field: "(source)", expected: "descriptor or source", got: "neither", hint: "runImport requires exactly one of opts.descriptor (YAML) or opts.source (AsyncIterable)" }); })());

  for await (const m of iterable) {
    total++;

    const resolvedAgent = m.agentId ?? opts.agentId;
    if (!resolvedAgent) {
      // Spec §4: agentId is required either on the record or as a flag.
      // We surface as a structured error rather than silently dropping —
      // the operator should know whether this is a descriptor bug or a
      // missing flag.
      throw new BridgeRuntimeError({
        bridge: opts.bridgeName,
        op: "import",
        field: "agentId",
        expected: "set on record OR provided via --agent",
        got: "missing",
        hint: `record ${total} has no agentId and no --agent default was provided. Pass --agent <id> on the import command, or have the descriptor map an agentId column.`,
      });
    }

    const durability = (m.durability && VALID_DURABILITY.has(m.durability))
      ? m.durability
      : "standard";

    const id = m.id ?? `${resolvedAgent}-${Date.now()}-${shortRand()}`;

    const body: PutMemoryBody = {
      id,
      agentId: resolvedAgent,
      content: m.content,
      durability,
      type: "memory",
      createdAt: m.createdAt ?? new Date().toISOString(),
    };
    if (m.subject) body.subject = m.subject;
    if (m.tags && m.tags.length > 0) body.tags = m.tags;
    if (m.visibility) body.visibility = m.visibility;
    if (m.validFrom) body.validFrom = m.validFrom;
    if (m.validTo) body.validTo = m.validTo;
    if (m.expiresAt) body.expiresAt = m.expiresAt;
    if (m.source) body.source = m.source;
    if (m.derivedFrom && m.derivedFrom.length > 0) body.derivedFrom = m.derivedFrom;
    if (m.foreignId) body.foreignId = m.foreignId;

    if (opts.dryRun) {
      skipped++;
      onProgress({ type: "memory-skipped", ordinal: total, reason: "--dry-run" });
      continue;
    }

    try {
      await opts.putMemory(body);
      imported++;
      onProgress({ type: "memory-imported", foreignId: m.foreignId, flairId: id, ordinal: total });
    } catch (err: any) {
      // Wrap PUT errors so they read consistently with other BridgeRuntimeErrors.
      throw new BridgeRuntimeError({
        bridge: opts.bridgeName,
        op: "import",
        record: total,
        field: "(write)",
        expected: "successful PUT /Memory",
        got: err?.message ?? String(err),
        hint: `Flair rejected the write for memory ${id}: ${err?.message ?? err}`,
      });
    }
  }

  onProgress({ type: "done", total, imported, skipped });
  return { total, imported, skipped };
}

function shortRand(): string {
  // Random 8-char suffix — enough collision space for a single import run
  // when paired with the timestamp. We don't use crypto.randomUUID() in the
  // ID because Flair's memory IDs are typically `<agent>-<ts>-<short>`.
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
