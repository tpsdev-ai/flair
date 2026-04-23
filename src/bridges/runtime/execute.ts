/**
 * Runtime executor for YAML (Shape A) bridges.
 *
 * `importFromYaml` takes a parsed `YamlBridgeDescriptor` plus a root directory
 * and yields `BridgeMemory` records — one per source record after the
 * descriptor's `map` has been applied. Callers stream the output into Flair
 * via the CLI (slice 2b) or the HTTP API directly.
 *
 * Failures are always `BridgeRuntimeError` with LLM-readable
 * `{bridge, op, path, record, field, expected, got, hint}`.
 */

import { join, isAbsolute } from "node:path";
import type {
  BridgeMemory,
  YamlBridgeDescriptor,
  BridgeContext,
} from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { parseRecords } from "./formats.js";
import { applyMap } from "./mapper.js";

export interface ImportOptions {
  /** Directory containing the foreign data; source paths are resolved relative to this. */
  cwd: string;
  /** Optional ctx for logging and cache — only used for informational output. */
  ctx?: BridgeContext;
}

const FLAIR_RESERVED_FIELDS_SET = new Set([
  "contentHash",
  "embedding",
  "embeddingModel",
  "retrievalCount",
  "lastRetrieved",
  "promotionStatus",
  "_safetyFlags",
  "createdBy",
  "updatedBy",
  "archivedBy",
]);

/**
 * Drive a YAML bridge's `import` block and yield `BridgeMemory` records.
 * Runs sources in order; one failure in a source halts the stream (the
 * spec's "every bridge error is structured" contract says we don't
 * silently discard partial imports).
 */
export async function* importFromYaml(
  descriptor: YamlBridgeDescriptor,
  opts: ImportOptions,
): AsyncIterable<BridgeMemory> {
  if (!descriptor.import) {
    throw new BridgeRuntimeError({
      bridge: descriptor.name,
      op: "import",
      field: "import",
      expected: "object with sources",
      got: "missing",
      hint: "descriptor has no `import` block — run `flair bridge export` instead, or add one",
    });
  }

  for (let srcIdx = 0; srcIdx < descriptor.import.sources.length; srcIdx++) {
    const source = descriptor.import.sources[srcIdx];
    const resolvedPath = resolvePath(opts.cwd, source.path);
    opts.ctx?.log.info(`importing source`, {
      source: source.path,
      format: source.format,
      resolved: resolvedPath,
    });

    for await (const { record, recordIndex } of parseRecords(descriptor.name, resolvedPath, source.format)) {
      const mapped = applyMap(source.map, record);

      // Reject any attempt to set Flair-reserved fields (spec §4).
      for (const f of Object.keys(mapped)) {
        if (FLAIR_RESERVED_FIELDS_SET.has(f)) {
          throw new BridgeRuntimeError({
            bridge: descriptor.name,
            op: "import",
            path: resolvedPath,
            record: recordIndex,
            field: `map.${f}`,
            expected: "non-reserved BridgeMemory field",
            got: f,
            hint: `Flair computes ${f} on ingest; bridges MUST NOT set it. Remove from the 'map:' block`,
          });
        }
      }

      // `content` is the only hard requirement from the spec (§4).
      if (typeof mapped.content !== "string" || mapped.content.length === 0) {
        throw new BridgeRuntimeError({
          bridge: descriptor.name,
          op: "import",
          path: resolvedPath,
          record: recordIndex,
          field: "map.content",
          expected: "non-empty string",
          got: mapped.content ?? "missing",
          hint: "every record must produce a non-empty `content`; check the source data and the 'map.content' expression",
        });
      }

      // Cast through unknown to honor BridgeMemory's declared shape without
      // trusting the mapper output.
      const bridgeMemory = mapped as unknown as BridgeMemory;
      yield bridgeMemory;
    }
  }
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}
