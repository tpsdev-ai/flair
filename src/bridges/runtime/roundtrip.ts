/**
 * Round-trip test harness for bridges.
 *
 * A bridge passes the round-trip test iff:
 *   1. Parse the fixture (or descriptor's first import.source.path) → pass1 BridgeMemory[]
 *   2. Apply export.targets[0]: when-filter → map → write to tmp in the
 *      target's format
 *   3. Re-import the tmp file using import.sources[0] → pass2 BridgeMemory[]
 *   4. pass1 and pass2 must agree on the round-trip-stable fields from the
 *      spec (§8): content, subject, tags, durability.
 *
 * This exercises the full mapper + predicate + writer + parser chain —
 * if a bridge author's descriptor has mapping bugs, the round-trip
 * surfaces them before memories ever reach Flair.
 *
 * Implementation note: does NOT talk to Flair. Fixture-to-fixture only.
 * Lives here so slice-3c code plugins can reuse the same harness.
 */

import { promises as fsp } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  BridgeMemory,
  YamlBridgeDescriptor,
} from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { parseRecords } from "./formats.js";
import { applyMap } from "./mapper.js";
import { evaluatePredicate } from "./predicate.js";
import { writeRecords } from "./writers.js";

/** Fields the spec (§8) requires to survive round-trip. */
export const ROUND_TRIP_STABLE_FIELDS = ["content", "subject", "tags", "durability"] as const;
type StableField = typeof ROUND_TRIP_STABLE_FIELDS[number];

export interface RoundTripOptions {
  descriptor: YamlBridgeDescriptor;
  /** Filesystem root the descriptor's relative paths resolve against. */
  cwd: string;
  /** Override the import source path. Defaults to descriptor's import.sources[0].path. */
  fixturePath?: string;
}

export interface RoundTripMismatch {
  /** 1-based index into the pass-1 memory list. */
  ordinal: number;
  /** foreignId (or content preview) used to match across passes. */
  key: string;
  /** Which stable field disagreed. */
  field: StableField;
  expected: unknown;
  got: unknown;
}

export interface RoundTripResult {
  passed: boolean;
  /** Records in pass 1 that passed the when-filter (i.e., expected to round-trip). */
  expectedCount: number;
  /** Records we found in pass 2. */
  actualCount: number;
  /** Per-field disagreements. Empty iff passed === true. */
  mismatches: RoundTripMismatch[];
  /** Records in pass 1 that had no match in pass 2 by match-key. */
  missingInPass2: Array<{ ordinal: number; key: string }>;
  /** Records in pass 2 that had no match in pass 1 (unexpected extras). */
  unexpectedInPass2: Array<{ key: string }>;
  /** Path of the intermediate export artifact (useful for debugging). */
  tmpExportPath: string;
}

export async function runRoundTrip(opts: RoundTripOptions): Promise<RoundTripResult> {
  const { descriptor, cwd } = opts;

  if (!descriptor.import || descriptor.import.sources.length === 0) {
    throw new BridgeRuntimeError({
      bridge: descriptor.name,
      op: "test",
      field: "import",
      expected: "descriptor with at least one import source",
      got: "missing or empty",
      hint: "round-trip needs an import block to start from. Add `import.sources:` to the descriptor.",
    });
  }
  if (!descriptor.export || descriptor.export.targets.length === 0) {
    throw new BridgeRuntimeError({
      bridge: descriptor.name,
      op: "test",
      field: "export",
      expected: "descriptor with at least one export target",
      got: "missing or empty",
      hint: "round-trip needs an export block to round-trip through. Add `export.targets:` to the descriptor.",
    });
  }

  const importSource = descriptor.import.sources[0];
  const exportTarget = descriptor.export.targets[0];

  const resolvedFixture = resolvePath(cwd, opts.fixturePath ?? importSource.path);
  const tmpDir = await fsp.mkdtemp(join(tmpdir(), `flair-bridge-test-${descriptor.name}-`));
  const tmpPath = join(tmpDir, `roundtrip.${suffixForFormat(exportTarget.format)}`);

  // Pass 1: fixture → BridgeMemory[]
  const pass1: BridgeMemory[] = [];
  for await (const { record } of parseRecords(descriptor.name, resolvedFixture, importSource.format)) {
    const mapped = applyMap(importSource.map, record) as unknown as BridgeMemory;
    pass1.push(mapped);
  }

  // Filter pass1 by the export target's when: (records filtered out wouldn't make it to the target).
  const expected: BridgeMemory[] = [];
  for (const m of pass1) {
    if (!exportTarget.when || exportTarget.when.trim() === "") {
      expected.push(m);
      continue;
    }
    const result = evaluatePredicate(exportTarget.when, m as unknown as Record<string, unknown>);
    if (result === "match" || result === "unparsable") expected.push(m);
  }

  // Export phase: apply export.map, write to tmp
  const shaped: Record<string, unknown>[] = [];
  for (const m of expected) {
    const out = applyMap(exportTarget.map, m as unknown as Record<string, unknown>);
    if (Object.keys(out).length === 0) continue;
    shaped.push(out);
  }
  await writeRecords(descriptor.name, tmpPath, exportTarget.format, shaped);

  // Pass 2: re-import the tmp using import.sources[0]'s map + format
  // (round-trip requires the bridge's own import map applied to what export wrote).
  const pass2: BridgeMemory[] = [];
  for await (const { record } of parseRecords(descriptor.name, tmpPath, importSource.format)) {
    const mapped = applyMap(importSource.map, record) as unknown as BridgeMemory;
    pass2.push(mapped);
  }

  // Match pass1[expected] with pass2 by key (foreignId if present, else content)
  // and diff the stable fields.
  const keyOf = (m: BridgeMemory): string => m.foreignId ?? (m.content ? `content:${m.content}` : "");
  const pass2ByKey = new Map<string, BridgeMemory>();
  for (const m of pass2) pass2ByKey.set(keyOf(m), m);

  const mismatches: RoundTripMismatch[] = [];
  const missingInPass2: Array<{ ordinal: number; key: string }> = [];
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i];
    const key = keyOf(a);
    const b = pass2ByKey.get(key);
    if (!b) {
      missingInPass2.push({ ordinal: i + 1, key });
      continue;
    }
    for (const field of ROUND_TRIP_STABLE_FIELDS) {
      if (!deepEqualField(a[field], b[field])) {
        mismatches.push({ ordinal: i + 1, key, field, expected: a[field], got: b[field] });
      }
    }
    // Matched this pass2 entry; remove so leftover tracking works
    pass2ByKey.delete(key);
  }

  const unexpectedInPass2 = Array.from(pass2ByKey.keys()).map((key) => ({ key }));

  const passed = mismatches.length === 0 && missingInPass2.length === 0 && unexpectedInPass2.length === 0;

  return {
    passed,
    expectedCount: expected.length,
    actualCount: pass2.length,
    mismatches,
    missingInPass2,
    unexpectedInPass2,
    tmpExportPath: tmpPath,
  };
}

function deepEqualField(a: unknown, b: unknown): boolean {
  // tags is the only array-valued stable field today; deep-equal shallowly
  // (order matters per our mapping; if a bridge re-orders tags, that's a
  // round-trip regression worth catching).
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // string / number / boolean / undefined: strict equality
  return a === b;
}

function suffixForFormat(format: string): string {
  switch (format) {
    case "jsonl": return "jsonl";
    case "json": return "json";
    case "yaml": return "yaml";
    case "markdown-frontmatter": return "md";
    default: return "out";
  }
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

// Keep randomUUID imported; future slice may use it for named tmp files.
void randomUUID;
