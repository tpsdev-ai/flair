/**
 * Export runner — drives a YAML descriptor's `export` block.
 *
 * Reads memories from Flair (via an injected fetcher), filters them
 * through the descriptor's `when:` predicate when present, applies the
 * `map:` to produce shaped output records, and writes to the target via
 * the format writer.
 *
 * Slice 3a supports Shape A (YAML descriptors) and the jsonl/json
 * formats. Markdown-frontmatter and code-plugin (Shape B) export land
 * in slice 3b/3c.
 *
 * As with import-runner, the Flair I/O is injected so the runner stays
 * unit-testable without spinning up a real Flair instance.
 */

import { isAbsolute, join } from "node:path";
import type {
  BridgeMemory,
  YamlBridgeDescriptor,
  BridgeContext,
} from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { applyMap } from "./mapper.js";
import { evaluatePredicate } from "./predicate.js";
import { writeRecords } from "./writers.js";

export interface ExportRunOptions {
  descriptor: YamlBridgeDescriptor;
  /** Filesystem root the descriptor's relative target paths resolve against. */
  cwd: string;
  /** Where the records come from. Receives the descriptor name + caller-passed filters. */
  fetchMemories: (filters: ExportFilters) => AsyncIterable<BridgeMemory>;
  /** Forwarded to `fetchMemories` and downstream telemetry. */
  filters?: ExportFilters;
  dryRun?: boolean;
  ctx?: BridgeContext;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ExportFilters {
  agentId?: string;
  subject?: string;
  durability?: BridgeMemory["durability"];
  /** Matches the descriptor's `source:` tag — most useful for round-tripping a single bridge's own data. */
  source?: string;
  /** validFrom >= this timestamp */
  since?: string;
}

export type ProgressEvent =
  | { type: "target-write"; path: string; written: number }
  | { type: "target-skipped"; path: string; reason: string }
  | { type: "memory-skipped"; ordinal: number; reason: string }
  | { type: "done"; total: number; exported: number };

export interface ExportRunResult {
  total: number;
  exported: number;
  perTarget: Array<{ path: string; written: number }>;
}

export async function runExport(opts: ExportRunOptions): Promise<ExportRunResult> {
  if (!opts.descriptor.export) {
    throw new BridgeRuntimeError({
      bridge: opts.descriptor.name,
      op: "export",
      field: "export",
      expected: "object with targets",
      got: "missing",
      hint: "descriptor has no `export` block — run `flair bridge import` instead, or add one",
    });
  }

  const onProgress = opts.onProgress ?? (() => {});
  const perTarget: ExportRunResult["perTarget"] = [];
  let total = 0;
  let exported = 0;

  // Pull all memories once and reuse across targets — typical case is a
  // single target. If a descriptor has multiple targets each with its own
  // when:, re-fetching per target would surprise the operator with N×
  // backend calls.
  const memories: BridgeMemory[] = [];
  for await (const m of opts.fetchMemories(opts.filters ?? {})) {
    memories.push(m);
    total++;
  }

  for (let tIdx = 0; tIdx < opts.descriptor.export.targets.length; tIdx++) {
    const target = opts.descriptor.export.targets[tIdx];
    const resolvedPath = isAbsolute(target.path) ? target.path : join(opts.cwd, target.path);

    // Apply when: filter
    const passing: BridgeMemory[] = [];
    if (target.when && target.when.trim()) {
      let unparsableSeen = false;
      for (let i = 0; i < memories.length; i++) {
        const result = evaluatePredicate(target.when, memories[i] as unknown as Record<string, unknown>);
        if (result === "unparsable") {
          if (!unparsableSeen) {
            unparsableSeen = true;
            opts.ctx?.log.warn(`when: clause unparsable, including all records for this target`, {
              when: target.when,
              targetPath: resolvedPath,
            });
          }
          passing.push(memories[i]);
        } else if (result === "match") {
          passing.push(memories[i]);
        } else {
          onProgress({ type: "memory-skipped", ordinal: i + 1, reason: `when: ${target.when}` });
        }
      }
    } else {
      passing.push(...memories);
    }

    // Apply map: to each surviving memory
    const shaped: Record<string, unknown>[] = [];
    for (let i = 0; i < passing.length; i++) {
      const out = applyMap(target.map, passing[i] as unknown as Record<string, unknown>);
      // The ONLY hard requirement on output is that the map produced at
      // least one field — empty mappings would produce empty JSONL lines
      // which are technically valid but suspicious. Skip them with a hint.
      if (Object.keys(out).length === 0) {
        onProgress({ type: "memory-skipped", ordinal: i + 1, reason: "map produced no fields" });
        continue;
      }
      shaped.push(out);
    }

    if (opts.dryRun) {
      onProgress({ type: "target-skipped", path: resolvedPath, reason: "--dry-run" });
      perTarget.push({ path: resolvedPath, written: 0 });
      continue;
    }

    opts.ctx?.log.info(`exporting target`, {
      target: target.path,
      format: target.format,
      records: shaped.length,
    });

    const { written } = await writeRecords(opts.descriptor.name, resolvedPath, target.format, shaped);
    perTarget.push({ path: resolvedPath, written });
    exported += written;
    onProgress({ type: "target-write", path: resolvedPath, written });
  }

  onProgress({ type: "done", total, exported });
  return { total, exported, perTarget };
}
